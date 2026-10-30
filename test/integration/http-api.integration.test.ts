import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { AppInstance } from '../support/instances';
import { betPayload, newPlayerId, resetDatabase } from '../support/integration';
import { createTestSqs, testQueueNames } from '../support/sqs';

/**
 * Contrato HTTP com a aplicação real (processo NestJS + Postgres + SQS):
 * status distintos e consistentes para cada situação (seção 9).
 */
const queues = testQueueNames();
let api: AppInstance;
let sqs: Awaited<ReturnType<typeof createTestSqs>>;

beforeAll(async () => {
  await resetDatabase();
  sqs = await createTestSqs(queues);
  api = await new AppInstance('http-api', queues).start();
}, 30_000);

afterAll(async () => {
  await api.stop();
  sqs.close();
});

async function wallet(balance = '100.00') {
  const res = await api.request('POST', '/wallets', { playerId: newPlayerId(), initialBalance: { amount: balance, currency: 'BRL' } });
  return { walletId: res.body.id as string, playerId: res.body.playerId as string };
}

const submit = (payload: Record<string, unknown>, key?: string | null) =>
  api.request(
    'POST',
    '/wagering/transactions',
    payload,
    key === null ? {} : { 'Idempotency-Key': key ?? `${payload.providerId}:${payload.externalTransactionId}` },
  );

describe('POST /wallets', () => {
  test('201 com o contrato do enunciado', async () => {
    const playerId = newPlayerId();
    const res = await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
  });

  test('409 para wallet duplicada', async () => {
    const playerId = newPlayerId();
    await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    const res = await api.request('POST', '/wallets', { playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  test.each([['25'], ['1e3'], ['-1.00'], ['10.555'], ['NaN']])('400 para amount inválido "%s"', async (amount) => {
    const res = await api.request('POST', '/wallets', { playerId: newPlayerId(), initialBalance: { amount, currency: 'BRL' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MONEY');
  });

  test('400 quando amount vem como number', async () => {
    const res = await api.request('POST', '/wallets', { playerId: newPlayerId(), initialBalance: { amount: 10, currency: 'BRL' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /wagering/transactions — um status por situação', () => {
  test('201 processada, 200 replay idêntico, 409 mesma key com payload diferente', async () => {
    const { walletId, playerId } = await wallet();
    const payload = betPayload(walletId, playerId, '25.00');
    const first = await submit(payload);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    const replay = await submit(payload);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await submit({ ...payload, money: { amount: '26.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT', retryable: false });
  });

  test('422 rejeição de negócio com failureCode', async () => {
    const { walletId, playerId } = await wallet('10.00');
    const res = await submit(betPayload(walletId, playerId, '20.00'));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
  });

  test('202 aceita com processamento pendente (referência ausente)', async () => {
    const { walletId, playerId } = await wallet();
    const res = await submit(betPayload(walletId, playerId, '5.00', { kind: 'REFUND', referenceExternalTransactionId: 'not-yet' }));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING_REFERENCE');
  });

  test.each([
    ['sem Idempotency-Key', null, {}],
    ['kind OPENING (interno)', undefined, { kind: 'OPENING' }],
    ['REFUND sem referência', undefined, { kind: 'REFUND' }],
    ['notação científica', undefined, { money: { amount: '1e2', currency: 'BRL' } }],
    ['walletId não-UUID', undefined, { walletId: 'abc' }],
  ])('400 payload inválido: %s', async (_name, key, override) => {
    const { walletId, playerId } = await wallet();
    const res = await submit({ ...betPayload(walletId, playerId, '1.00'), ...override }, key as string | null | undefined);
    expect(res.status).toBe(400);
    expect(res.body.error.retryable).toBe(false);
  });

  test('X-Correlation-Id é aceito e devolvido', async () => {
    const res = await fetch(`${api.baseUrl}/health/live`, { headers: { 'X-Correlation-Id': 'abc-123' } });
    expect(res.headers.get('x-correlation-id')).toBe('abc-123');
  });
});

describe('Consultas', () => {
  test('GET por id interno e por (providerId, externalTransactionId); 404 quando não existe', async () => {
    const { walletId, playerId } = await wallet();
    const payload = betPayload(walletId, playerId, '1.00');
    const created = await submit(payload);
    const byId = await api.request('GET', `/wagering/transactions/${created.body.transactionId}`);
    const byExternal = await api.request('GET', `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`);
    expect(byId.status).toBe(200);
    expect(byExternal.body).toEqual(byId.body);
    expect((await api.request('GET', `/wagering/transactions/${Bun.randomUUIDv7()}`)).status).toBe(404);
    expect((await api.request('GET', `/wallets/${Bun.randomUUIDv7()}`)).status).toBe(404);
  });

  test('ledger paginado com cursor opaco; cursor inválido → 400', async () => {
    const { walletId, playerId } = await wallet();
    await submit(betPayload(walletId, playerId, '1.00'));
    const page1 = await api.request('GET', `/wallets/${walletId}/ledger?limit=1`);
    expect(page1.body.items).toHaveLength(1);
    const page2 = await api.request('GET', `/wallets/${walletId}/ledger?limit=1&cursor=${page1.body.nextCursor}`);
    expect(page2.body.items[0].walletVersion).toBe(2);
    expect(page2.body.nextCursor).toBeNull();
    expect((await api.request('GET', `/wallets/${walletId}/ledger?cursor=lixo`)).status).toBe(400);
  });

  test('reconciliação consistente', async () => {
    const { walletId, playerId } = await wallet('975.00');
    await submit(betPayload(walletId, playerId, '5.00'));
    const res = await api.request('POST', `/wallets/${walletId}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId,
      storedBalance: { amount: '970.00', currency: 'BRL' },
      calculatedBalance: { amount: '970.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });
});

describe('Operação', () => {
  test('health live/ready sem autenticação', async () => {
    expect((await api.request('GET', '/health/live')).status).toBe(200);
    const ready = await api.request('GET', '/health/ready');
    expect(ready.body).toEqual({ status: 'ready', checks: { postgres: 'up', sqs: 'up' } });
  });

  test('/metrics expõe as métricas exigidas', async () => {
    const text = await (await fetch(`${api.baseUrl}/metrics`)).text();
    for (const name of [
      'wagering_transactions_total',
      'wagering_duplicates_detected_total',
      'wagering_processing_duration_seconds',
      'wagering_outbox_lag_seconds',
      'wagering_dlq_depth',
    ]) {
      expect(text).toContain(name);
    }
  });
});
