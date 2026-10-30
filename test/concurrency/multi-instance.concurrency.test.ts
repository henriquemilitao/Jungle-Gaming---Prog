import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AppInstance } from '../support/instances';
import {
  assertLedgerMatchesBalance,
  betPayload,
  createTestApp,
  newPlayerId,
  resetDatabase,
  type TestApp,
} from '../support/integration';
import { createTestSqs, testQueueNames, wagerMessage, waitUntil } from '../support/sqs';

/**
 * ≥ 3 PROCESSOS da aplicação rodando ao mesmo tempo, compartilhando PostgreSQL e SQS reais.
 * Cada processo tem seu próprio pool, memória, consumidor e workers — exatamente como
 * 3 containers em produção. Também cobre crash (SIGKILL) e reinício.
 */
const queues = testQueueNames('multi');
let sqs: Awaited<ReturnType<typeof createTestSqs>>;
let app: TestApp;
let instances: AppInstance[] = [];

beforeAll(async () => {
  await resetDatabase();
  sqs = await createTestSqs(queues);
  app = await createTestApp();
  instances = await Promise.all(['app-1', 'app-2', 'app-3'].map((n) => new AppInstance(n, queues).start()));
}, 60_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => i.stop()));
  await app.close();
  sqs.close();
});

/** Cria a wallet pela API de uma instância (ou direto no use case quando não há instâncias de pé). */
async function newWallet(balance: string) {
  const playerId = newPlayerId();
  if (instances.length === 0) {
    const view = await app.openWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' }, correlationId: 't' });
    return { walletId: view.id, playerId };
  }
  const res = await instances[0]!.request('POST', '/wallets', { playerId, initialBalance: { amount: balance, currency: 'BRL' } });
  expect(res.status).toBe(201);
  return { walletId: res.body.id as string, playerId };
}

const submitVia = (instance: AppInstance, payload: ReturnType<typeof betPayload>) =>
  instance.request('POST', '/wagering/transactions', payload, {
    'Idempotency-Key': `${payload.providerId}:${payload.externalTransactionId}`,
  });

const balanceOf = async (walletId: string) => (await app.queries.getWallet(walletId)).balance.amount;
const debitCount = async (walletId: string) =>
  (
    await app.sql<{ n: number }>(`select count(*)::int as n from wallet_ledger_entry where wallet_id = ? and direction = 'DEBIT'`, [
      walletId,
    ])
  )[0]!.n;

describe('3 instâncias simultâneas', () => {
  test('a mesma aposta enviada 60× em paralelo, espalhada pelas 3 instâncias → um único débito', async () => {
    const { walletId, playerId } = await newWallet('1000.00');
    const payload = betPayload(walletId, playerId, '25.00');

    const responses = await Promise.all(Array.from({ length: 60 }, (_, i) => submitVia(instances[i % 3]!, payload)));

    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200 && r.body.idempotentReplay === true)).toHaveLength(59);
    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(await debitCount(walletId)).toBe(1);
    expect(await balanceOf(walletId)).toBe('975.00');
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('cenário 100 / 80 / 80 com cada aposta numa instância diferente (10 wallets)', async () => {
    for (let round = 0; round < 10; round++) {
      const { walletId, playerId } = await newWallet('100.00');
      const [a, b] = await Promise.all([
        submitVia(instances[round % 3]!, betPayload(walletId, playerId, '80.00')),
        submitVia(instances[(round + 1) % 3]!, betPayload(walletId, playerId, '80.00')),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 422]);
      expect([a, b].find((r) => r.status === 422)!.body.failureCode).toBe('INSUFFICIENT_FUNDS');
      expect(await balanceOf(walletId)).toBe('20.00');
      expect(await debitCount(walletId)).toBe(1);
      await assertLedgerMatchesBalance(app, walletId);
    }
  });

  test('SQS: 3 consumidores, 8 wallets × 10 apostas, cada mensagem entregue 2× → saldos exatos', async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => newWallet('100.00')));
    const sends: Promise<void>[] = [];
    for (const w of wallets) {
      for (let i = 0; i < 10; i++) {
        const msg = wagerMessage(betPayload(w.walletId, w.playerId, '3.00'));
        sends.push(sqs.sendWager(msg, w.walletId), sqs.sendWager(msg, w.walletId)); // duplicata
      }
    }
    await Promise.all(sends);

    await waitUntil(async () => {
      const balances = await Promise.all(wallets.map((w) => balanceOf(w.walletId)));
      return balances.every((b) => b === '70.00');
    }, 60_000);
    for (const w of wallets) {
      expect(await debitCount(w.walletId)).toBe(10);
      await assertLedgerMatchesBalance(app, w.walletId);
    }
    expect(await sqs.drain(queues.wagerDlqName, 500)).toHaveLength(0);
  }, 90_000);

  test('REFUND numa instância antes da BET em outra → resolvido pelo worker de qualquer instância', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const bet = betPayload(walletId, playerId, '40.00');
    const refund = betPayload(walletId, playerId, '40.00', { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId });

    const pending = await submitVia(instances[0]!, refund);
    expect(pending.status).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    expect((await submitVia(instances[1]!, bet)).status).toBe(201);
    await waitUntil(async () => (await balanceOf(walletId)) === '100.00');
    const tx = await instances[2]!.request('GET', `/wagering/transactions/${pending.body.transactionId}`);
    expect(tx.body.status).toBe('PROCESSED');
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('reinício (SIGTERM) no meio de uma rajada pela fila → nada perdido, nada duplicado', async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => newWallet('500.00')));
    const sends: Promise<void>[] = [];
    for (const w of wallets) {
      for (let i = 0; i < 15; i++) sends.push(sqs.sendWager(wagerMessage(betPayload(w.walletId, w.playerId, '2.00')), w.walletId));
    }
    await Promise.all(sends);
    await Bun.sleep(300);

    // Shutdown gracioso das 3 instâncias enquanto processam...
    const codes = await Promise.all(instances.map((i) => i.stop()));
    expect(codes.every((c) => c === 0)).toBe(true);
    // ...e sobem 3 novas.
    instances = await Promise.all(['app-4', 'app-5', 'app-6'].map((n) => new AppInstance(n, queues).start()));

    await waitUntil(async () => {
      const balances = await Promise.all(wallets.map((w) => balanceOf(w.walletId)));
      return balances.every((b) => b === '470.00');
    }, 60_000);
    for (const w of wallets) {
      expect(await debitCount(w.walletId)).toBe(15);
      await assertLedgerMatchesBalance(app, w.walletId);
    }
  }, 90_000);
});

describe('Crash recovery (SIGKILL)', () => {
  // Isola os cenários de crash: só as instâncias de cada teste ficam de pé
  // (senão os publishers/consumidores das outras 3 fariam o trabalho por elas).
  beforeAll(async () => {
    await Promise.all(instances.map((i) => i.stop()));
    instances = [];
  });

  test('worker morto DEPOIS do commit e ANTES do ack → redelivery reconhecida pela inbox, sem duplicar', async () => {
    const isolated = testQueueNames();
    const isolatedSqs = await createTestSqs(isolated);
    const { walletId, playerId } = await newWallet('100.00');
    const msg = wagerMessage(betPayload(walletId, playerId, '30.00'));

    const doomed = await new AppInstance('doomed', isolated, { FAULT_INJECTION: 'crash-after-commit-before-ack' }).start();
    await isolatedSqs.sendWager(msg, walletId);
    expect(await doomed.exited).not.toBe(0); // morreu com SIGKILL logo após o COMMIT

    // O COMMIT aconteceu (saldo debitado), mas a mensagem NÃO foi confirmada.
    expect(await balanceOf(walletId)).toBe('70.00');

    // Outra instância assume: recebe a mensagem de novo, a inbox reconhece, só faz ack.
    const survivor = await new AppInstance('survivor', isolated).start();
    try {
      await Bun.sleep(5_000); // visibility timeout (2s) + processamento
      expect(await isolatedSqs.drain(isolated.wagerQueueName, 1_000)).toHaveLength(0);
      expect(await balanceOf(walletId)).toBe('70.00');
      expect(await debitCount(walletId)).toBe(1);
      await assertLedgerMatchesBalance(app, walletId);
    } finally {
      await survivor.stop();
      isolatedSqs.close();
    }
  }, 60_000);

  test('commit confirmado e processo morto antes de publicar → outra instância publica os eventos', async () => {
    const isolated = testQueueNames();
    const isolatedSqs = await createTestSqs(isolated);
    await app.sql(`update outbox_message set published_at = now(), next_attempt_at = null where published_at is null`);

    // Instância que processa mas não chega a publicar (publisher desligado = "morreu antes de publicar").
    const writer = await new AppInstance('writer', isolated, { OUTBOX_PUBLISHER_ENABLED: 'false' }).start();
    const { walletId, playerId } = await (async () => {
      const res = await writer.request('POST', '/wallets', { playerId: newPlayerId(), initialBalance: { amount: '50.00', currency: 'BRL' } });
      return { walletId: res.body.id as string, playerId: res.body.playerId as string };
    })();
    await submitVia(writer, betPayload(walletId, playerId, '5.00'));
    await writer.kill();

    const pending = await app.sql<{ id: string }>(`select id from outbox_message where published_at is null`);
    expect(pending).toHaveLength(4); // OPENING (2) + BET (2)

    // Uma instância que publica e MORRE antes de marcar como publicado → publicação duplicada.
    const flaky = new AppInstance('flaky', isolated, { FAULT_INJECTION: 'crash-after-publish-before-mark' }).spawn();
    expect(await flaky.exited).not.toBe(0);

    // Outra instância assume e publica (de novo, se preciso).
    const publisher = await new AppInstance('publisher', isolated).start();
    try {
      await waitUntil(async () => (await app.sql(`select 1 from outbox_message where published_at is null`)).length === 0);
      const delivered = await isolatedSqs.drain(isolated.eventsQueueName);
      const ids = delivered.map((m) => JSON.parse(m.Body!).eventId as string);
      // Consumidor deduplica por eventId: o conjunto único é exatamente o que estava na outbox.
      expect(new Set(ids)).toEqual(new Set(pending.map((p) => p.id)));
      expect(ids.length).toBeGreaterThanOrEqual(4);
    } finally {
      await publisher.stop();
      isolatedSqs.close();
    }
  }, 60_000);
});
