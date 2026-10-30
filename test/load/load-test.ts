/**
 * Teste de carga (diferencial opcional) — `bun run test:load`
 *
 * Por padrão usa as 3 instâncias do docker compose (http://localhost:3001..3003).
 * Variáveis:
 *   LOAD_BASE_URLS   lista separada por vírgula (padrão: as 3 do compose)
 *   LOAD_SPAWN=3     em vez disso, sobe N instâncias locais (usa TEST_DATABASE_URL / TEST_SQS_ENDPOINT)
 *   LOAD_DURATION_S  duração (padrão 30)
 *   LOAD_VUS         usuários virtuais concorrentes (padrão 40)
 *   LOAD_WALLETS     wallets "normais" (padrão 200)
 *   LOAD_HOT_SHARE   fração das apostas na MESMA wallet "quente" (padrão 0.2)
 *   LOAD_DUP_SHARE   fração de reenvios idênticos (replay idempotente) (padrão 0.1)
 *   LOAD_EVENTS_QUEUE fila de eventos consumida durante o teste (padrão wallet-events.fifo)
 *
 * Mede: throughput, latência p50/p95/p99, taxa de erro, distribuição de status,
 * conflitos de lock (métrica das instâncias), outbox lag, e ao final roda a
 * reconciliação de TODAS as wallets (a correção vale mais que o número).
 */
import { DeleteMessageBatchCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { createSqsClient, QueueUrls } from '../../src/infrastructure/messaging/sqs';
import { AppInstance } from '../support/instances';
import { resetDatabase } from '../support/integration';
import { createTestSqs, testQueueNames, TEST_SQS_ENDPOINT } from '../support/sqs';

const env = (k: string, d: string) => process.env[k] ?? d;
const DURATION_S = Number(env('LOAD_DURATION_S', '30'));
const VUS = Number(env('LOAD_VUS', '40'));
const WALLETS = Number(env('LOAD_WALLETS', '200'));
const HOT_SHARE = Number(env('LOAD_HOT_SHARE', '0.2'));
const DUP_SHARE = Number(env('LOAD_DUP_SHARE', '0.1'));
const SPAWN = Number(env('LOAD_SPAWN', '0'));

interface Wallet {
  walletId: string;
  playerId: string;
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const started = performance.now();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, body: json, ms: performance.now() - started };
}

async function scrape(base: string): Promise<Record<string, number>> {
  const text = await (await fetch(`${base}/metrics`)).text();
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('wagering_')) continue;
    const [key, value] = [line.slice(0, line.lastIndexOf(' ')), Number(line.slice(line.lastIndexOf(' ') + 1))];
    out[key] = value;
  }
  return out;
}

async function main() {
  let instances: AppInstance[] = [];
  let eventsQueue = env('LOAD_EVENTS_QUEUE', 'wallet-events.fifo');
  let bases = env('LOAD_BASE_URLS', 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',');

  if (SPAWN > 0) {
    await resetDatabase();
    const queues = testQueueNames();
    const sqs = await createTestSqs(queues);
    sqs.close();
    instances = await Promise.all(
      Array.from({ length: SPAWN }, (_, i) => new AppInstance(`load-${i + 1}`, queues, { DATABASE_POOL_MAX: '20' }).start()),
    );
    bases = instances.map((i) => i.baseUrl);
    eventsQueue = queues.eventsQueueName;
  }

  // "Sistema downstream": consome a fila de eventos durante o teste, deduplicando por eventId.
  const downstream = createSqsClient({ endpoint: env('SQS_ENDPOINT', TEST_SQS_ENDPOINT), region: 'us-east-1' });
  const eventsUrl = await new QueueUrls(downstream).get(eventsQueue);
  const eventIds = new Set<string>();
  let eventsReceived = 0;
  let stopWhenIdle = false;
  let lastReceivedAt = Date.now();
  const consumer = (async () => {
    while (!(stopWhenIdle && Date.now() - lastReceivedAt > 3_000)) {
      const res = await downstream.send(new ReceiveMessageCommand({ QueueUrl: eventsUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      const msgs = res.Messages ?? [];
      if (msgs.length > 0) lastReceivedAt = Date.now();
      for (const m of msgs) {
        eventsReceived++;
        eventIds.add((JSON.parse(m.Body!) as { eventId: string }).eventId);
      }
      if (msgs.length > 0) {
        await downstream.send(
          new DeleteMessageBatchCommand({ QueueUrl: eventsUrl, Entries: msgs.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })) }),
        );
      }
    }
  })();

  console.log(`[load] ${bases.length} instâncias, ${VUS} VUs, ${DURATION_S}s, ${WALLETS} wallets, hot=${HOT_SHARE}, dup=${DUP_SHARE}`);

  // Preparação: wallets com saldo alto (normais) + 1 wallet "quente" com saldo limitado.
  const wallets: Wallet[] = [];
  for (let i = 0; i < WALLETS; i++) {
    const r = await post(bases[i % bases.length]!, '/wallets', {
      playerId: Bun.randomUUIDv7(),
      initialBalance: { amount: '1000000.00', currency: 'BRL' },
    });
    wallets.push({ walletId: r.body.id, playerId: r.body.playerId });
  }
  const hotRes = await post(bases[0]!, '/wallets', { playerId: Bun.randomUUIDv7(), initialBalance: { amount: '5000.00', currency: 'BRL' } });
  const hot: Wallet = { walletId: hotRes.body.id, playerId: hotRes.body.playerId };

  const latencies: number[] = [];
  const statusCount: Record<string, number> = {};
  const sent: Array<{ payload: Record<string, unknown> }> = [];
  let errors = 0;
  let seq = 0;
  const deadline = performance.now() + DURATION_S * 1000;

  const vu = async (n: number) => {
    while (performance.now() < deadline) {
      const base = bases[(n + seq) % bases.length]!;
      let payload: Record<string, unknown>;
      if (sent.length > 0 && Math.random() < DUP_SHARE) {
        payload = sent[Math.floor(Math.random() * sent.length)]!.payload; // reenvio idêntico
      } else {
        const w = Math.random() < HOT_SHARE ? hot : wallets[Math.floor(Math.random() * wallets.length)]!;
        payload = {
          providerId: 'load-provider',
          externalTransactionId: `load-${n}-${++seq}`,
          playerId: w.playerId,
          walletId: w.walletId,
          roundId: `round-${seq}`,
          gameId: 'load-game',
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        };
        if (sent.length < 5_000) sent.push({ payload });
      }
      try {
        const r = await post(base, '/wagering/transactions', payload, {
          'Idempotency-Key': `${payload.providerId}:${payload.externalTransactionId}`,
        });
        latencies.push(r.ms);
        const key = `${r.status}${r.body.idempotentReplay ? ' (replay)' : ''}${r.body.failureCode ? ` ${r.body.failureCode}` : ''}`;
        statusCount[key] = (statusCount[key] ?? 0) + 1;
        if (r.status >= 500) errors++;
      } catch (err) {
        errors++;
        const key = `erro de rede: ${(err as Error).message.slice(0, 80)}`;
        statusCount[key] = (statusCount[key] ?? 0) + 1;
      }
    }
  };

  const started = performance.now();
  await Promise.all(Array.from({ length: VUS }, (_, i) => vu(i)));
  const elapsedS = (performance.now() - started) / 1000;

  // Coleta pós-carga
  await Bun.sleep(1_000);
  const metrics = await Promise.all(bases.map(scrape));

  // Quanto tempo a outbox leva para zerar depois que a carga para.
  const drainStarted = performance.now();
  let outboxDrainS: number | null = null;
  while (performance.now() - drainStarted < 120_000) {
    const pending = (await Promise.all(bases.map(scrape))).map((m) => m['wagering_outbox_pending_messages'] ?? 0);
    if (Math.max(...pending) === 0) {
      outboxDrainS = Number(((performance.now() - drainStarted) / 1000).toFixed(1));
      break;
    }
    await Bun.sleep(500);
  }
  const sum = (prefix: string) =>
    metrics.reduce((acc, m) => acc + Object.entries(m).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v, 0), 0);
  const outboxLag = Math.max(...metrics.map((m) => m['wagering_outbox_lag_seconds'] ?? 0));

  stopWhenIdle = true; // termina de consumir o que já foi publicado
  await consumer;
  downstream.destroy();

  let inconsistent = 0;
  for (const w of [...wallets, hot]) {
    const r = await post(bases[0]!, `/wallets/${w.walletId}/reconciliation`, {});
    if (!r.body.consistent) inconsistent++;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const report = {
    ambiente: {
      instancias: bases.length,
      bun: Bun.version,
      plataforma: `${process.platform}/${process.arch}`,
      vus: VUS,
      duracaoS: Number(elapsedS.toFixed(1)),
      wallets: WALLETS,
      fracaoHotWallet: HOT_SHARE,
      fracaoDuplicatas: DUP_SHARE,
    },
    requisicoes: latencies.length,
    throughputRps: Number((latencies.length / elapsedS).toFixed(1)),
    latenciaMs: {
      p50: Number(percentile(sorted, 50).toFixed(1)),
      p95: Number(percentile(sorted, 95).toFixed(1)),
      p99: Number(percentile(sorted, 99).toFixed(1)),
      max: Number((sorted.at(-1) ?? 0).toFixed(1)),
    },
    taxaErro: Number((errors / Math.max(latencies.length, 1)).toFixed(4)),
    status: statusCount,
    conflitosDeLock: sum('wagering_lock_conflicts_total'),
    retriesTransacaoDb: sum('wagering_retries_total{operation="db_transaction"}'),
    outboxLagSegundosAoFinal: outboxLag,
    outboxSegundosParaZerarAposCarga: outboxDrainS,
    eventosRecebidosDownstream: eventsReceived,
    eventosUnicosPorEventId: eventIds.size,
    reconciliacao: { walletsVerificadas: wallets.length + 1, inconsistentes: inconsistent },
  };
  console.log(JSON.stringify(report, null, 2));

  await Promise.all(instances.map((i) => i.stop()));
  if (inconsistent > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
