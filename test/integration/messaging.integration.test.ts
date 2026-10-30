import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadConfig, type AppConfig } from '../../src/config';
import { createContainer, type AppContainer } from '../../src/container';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { ExponentialBackoff } from '../../src/domain/shared/exponential-backoff';
import { noopLogger, noopMetrics } from '../../src/application/observability';
import { FaultInjector } from '../../src/infrastructure/support/fault-injection';
import { createSqsClient, QueueUrls } from '../../src/infrastructure/messaging/sqs';
import { assertLedgerMatchesBalance, betPayload, createTestApp, newPlayerId, resetDatabase, TEST_DATABASE_URL, type TestApp } from '../support/integration';
import { createTestSqs, testQueueNames, TEST_SQS_ENDPOINT, wagerMessage, waitUntil } from '../support/sqs';

/**
 * Mensageria com PostgreSQL e SQS reais: inbox, redelivery, DLQ, retry, outbox.
 */
const queues = testQueueNames();
let sqs: Awaited<ReturnType<typeof createTestSqs>>;
let app: TestApp;
let container: AppContainer;

function testConfig(overrides: { databaseUrl?: string; sqsEndpoint?: string } = {}): AppConfig {
  const base = loadConfig();
  return {
    ...base,
    instanceId: 'integration',
    logLevel: 'silent',
    database: { ...base.database, url: overrides.databaseUrl ?? TEST_DATABASE_URL, poolMax: 10, lockTimeoutMs: 2_000 },
    sqs: {
      ...base.sqs,
      ...queues,
      endpoint: overrides.sqsEndpoint ?? TEST_SQS_ENDPOINT,
      waitTimeSeconds: 1,
      visibilityTimeoutSeconds: 2,
      maxReceiveCount: 3,
      retryBaseDelaySeconds: 1,
      consumerConcurrency: 1,
    },
    workers: { ...base.workers, shutdownGraceMs: 3_000 },
  };
}

beforeAll(async () => {
  await resetDatabase();
  sqs = await createTestSqs(queues);
  app = await createTestApp();
  container = await createContainer(testConfig());
  container.consumer.start();
});

afterAll(async () => {
  await container.consumer.stop();
  await container.orm.close(true);
  container.sqs.destroy();
  await app.close();
  sqs.close();
});

async function newWallet(balance = '100.00') {
  const playerId = newPlayerId();
  const view = await app.openWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' }, correlationId: 't' });
  return { walletId: view.id, playerId };
}

const balanceOf = async (walletId: string) => (await app.queries.getWallet(walletId)).balance.amount;
const inboxHas = async (messageId: string) =>
  (await app.sql(`select 1 from inbox_message where message_id = ?`, [messageId])).length === 1;

describe('Consumidor SQS', () => {
  test('processa, grava inbox na mesma transação e faz ack (a fila esvazia)', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const msg = wagerMessage(betPayload(walletId, playerId, '25.00'));
    await sqs.sendWager(msg, walletId);

    await waitUntil(async () => (await balanceOf(walletId)) === '75.00');
    expect(await inboxHas(msg.messageId)).toBe(true);
    expect(await sqs.drain(queues.wagerQueueName, 2_500)).toHaveLength(0); // houve ack
  });

  test('redelivery da MESMA mensagem: inbox detecta e não duplica o débito', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const msg = wagerMessage(betPayload(walletId, playerId, '10.00'));
    await sqs.sendWager(msg, walletId);
    await sqs.sendWager(msg, walletId); // SQS at-least-once: mesma mensagem de novo
    await sqs.sendWager(msg, walletId);

    await waitUntil(async () => (await balanceOf(walletId)) === '90.00');
    await Bun.sleep(2_500);
    expect(await balanceOf(walletId)).toBe('90.00');
    const debits = await app.sql<{ n: number }>(
      `select count(*)::int as n from wallet_ledger_entry where wallet_id = ? and direction = 'DEBIT'`,
      [walletId],
    );
    expect(debits[0]!.n).toBe(1);
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('rejeição de NEGÓCIO é terminal: ack, sem DLQ', async () => {
    const { walletId, playerId } = await newWallet('5.00');
    const msg = wagerMessage(betPayload(walletId, playerId, '50.00'));
    await sqs.sendWager(msg, walletId);
    await waitUntil(() => inboxHas(msg.messageId));
    const [tx] = await app.sql<{ status: string; failure_code: string }>(
      `select status, failure_code from wager_transaction where external_transaction_id = ?`,
      [msg.data.externalTransactionId],
    );
    expect(tx).toEqual({ status: 'REJECTED', failure_code: 'INSUFFICIENT_FUNDS' });
  });

  test('erros PERMANENTES vão para a DLQ com o motivo: mensagem inválida e conflito de idempotência', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const original = wagerMessage(betPayload(walletId, playerId, '10.00'));
    await sqs.sendWager(original, walletId);
    await waitUntil(() => inboxHas(original.messageId));

    const conflicting = wagerMessage({ ...original.data, money: { amount: '99.00', currency: 'BRL' } });
    await sqs.sendWager(conflicting, walletId);
    await sqs.sendWager('{ not json', walletId);
    await sqs.sendWager(wagerMessage(betPayload(walletId, playerId, '1.00', { kind: 'OPENING' })), walletId);

    const dead: string[] = [];
    await waitUntil(async () => {
      const msgs = await sqs.drain(queues.wagerDlqName, 500);
      dead.push(...msgs.map((m) => m.MessageAttributes?.failureReason?.StringValue ?? '?'));
      return dead.length >= 3;
    });
    expect(dead.sort()).toEqual(['IDEMPOTENCY_KEY_CONFLICT', 'INVALID_MESSAGE', 'KIND_NOT_ALLOWED']);
    expect(await balanceOf(walletId)).toBe('90.00');
  });

  test('REFUND pela fila antes da BET → PENDING_REFERENCE e depois PROCESSED', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const bet = betPayload(walletId, playerId, '30.00');
    const refund = betPayload(walletId, playerId, '30.00', { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });
    await sqs.sendWager(wagerMessage(refund), walletId);
    await waitUntil(async () => {
      const rows = await app.sql<{ status: string }>(`select status from wager_transaction where external_transaction_id = ?`, [
        refund.externalTransactionId,
      ]);
      return rows[0]?.status === 'PENDING_REFERENCE';
    });
    await sqs.sendWager(wagerMessage(bet), walletId);
    await waitUntil(async () => (await balanceOf(walletId)) === '70.00');
    await app.resolvePending.runOnce();
    expect(await balanceOf(walletId)).toBe('100.00');
    await assertLedgerMatchesBalance(app, walletId);
  });
});

describe('Erros transitórios: retry com backoff e limite antes da DLQ', () => {
  test('PostgreSQL indisponível → não faz ack, tenta de novo e, esgotado o limite, DLQ', async () => {
    const isolated = testQueueNames();
    const isolatedSqs = await createTestSqs(isolated);
    const base = testConfig({ databaseUrl: 'postgres://postgres:postgres@127.0.0.1:1/unreachable' });
    const broken = await createContainer({ ...base, sqs: { ...base.sqs, ...isolated } });
    broken.consumer.start();
    try {
      await isolatedSqs.sendWager(wagerMessage(betPayload(Bun.randomUUIDv7(), newPlayerId(), '1.00')), 'g1');
      let dead: string | undefined;
      await waitUntil(async () => {
        const [m] = await isolatedSqs.drain(isolated.wagerDlqName, 300);
        dead = m?.MessageAttributes?.failureReason?.StringValue;
        return dead !== undefined;
      }, 30_000);
      expect(dead).toBe('MAX_RECEIVES_EXCEEDED:DATABASE_UNAVAILABLE');
    } finally {
      await broken.consumer.stop();
      await broken.orm.close(true);
      broken.sqs.destroy();
      isolatedSqs.close();
    }
  }, 40_000);
});

describe('Transactional Outbox', () => {
  function publisher(endpoint = TEST_SQS_ENDPOINT) {
    const client = createSqsClient({ endpoint, region: 'us-east-1' });
    return {
      client,
      instance: new OutboxPublisher(
        app.orm,
        client,
        new QueueUrls(client),
        { eventsQueueName: queues.eventsQueueName, batchSize: 7, retryBackoff: new ExponentialBackoff(200, 1_000) },
        noopMetrics,
        noopLogger,
        new FaultInjector(''),
      ),
    };
  }

  test('dois publishers concorrentes sobre a mesma outbox: tudo publicado, sem duplicar', async () => {
    await sqs.drain(queues.eventsQueueName, 500);
    await app.sql(`update outbox_message set published_at = now(), next_attempt_at = null where published_at is null`);

    const { walletId, playerId } = await newWallet('1000.00');
    for (let i = 0; i < 20; i++) {
      await app.processWager.execute({
        idempotencyKey: `k-${walletId}-${i}`,
        payload: betPayload(walletId, playerId, '1.00') as never,
        source: { type: 'http' },
        correlationId: 't',
      });
    }
    const pending = await app.sql<{ id: string }>(`select id from outbox_message where published_at is null`);
    expect(pending.length).toBe(42); // abertura (2) + 20 apostas × (Processed + BalanceChanged)

    const a = publisher();
    const b = publisher();
    // Os dois disputam a mesma outbox ao mesmo tempo, até esvaziar.
    const drainWith = async (p: OutboxPublisher) => {
      while ((await p.publishBatch()) > 0) {
        /* continua */
      }
    };
    await Promise.all([drainWith(a.instance), drainWith(b.instance)]);
    a.client.destroy();
    b.client.destroy();

    const left = await app.sql(`select id from outbox_message where published_at is null`);
    expect(left).toHaveLength(0);
    const delivered = await sqs.drain(queues.eventsQueueName);
    const eventIds = delivered.map((m) => JSON.parse(m.Body!).eventId as string);
    expect(new Set(eventIds).size).toBe(42);
    expect(new Set(eventIds)).toEqual(new Set(pending.map((p) => p.id)));
  });

  test('SQS indisponível ao publicar → backoff (attempts++), nada se perde; depois publica', async () => {
    await app.sql(`update outbox_message set published_at = now(), next_attempt_at = null where published_at is null`);
    await newWallet('10.00'); // gera 2 eventos

    // Resolve a URL com o SQS real, mas envia para um endpoint morto.
    const dead = publisher('http://127.0.0.1:1');
    (dead.instance as unknown as { queues: QueueUrls }).queues = new QueueUrls(sqs.client);
    await dead.instance.publishBatch();
    dead.client.destroy();

    const rows = await app.sql<{ attempts: number; published_at: Date | null }>(
      `select attempts, published_at from outbox_message where published_at is null`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);

    await Bun.sleep(400); // passa o backoff
    const ok = publisher();
    expect(await ok.instance.publishBatch()).toBe(2);
    ok.client.destroy();
  });
});
