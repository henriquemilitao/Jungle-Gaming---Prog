import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError, WalletAlreadyExistsError } from '../../src/application/errors';
import type { WagerResult } from '../../src/application/wagering/wager-result';
import type { SubmitWagerPayload } from '../../src/application/wagering/process-wager-transaction.use-case';
import { ValidationError } from '../../src/domain/shared/domain-error';
import {
  assertLedgerMatchesBalance,
  betPayload,
  createTestApp,
  newPlayerId,
  resetDatabase,
  type TestApp,
} from '../support/integration';

let app: TestApp;

beforeAll(async () => {
  await resetDatabase();
  app = await createTestApp({ referenceBaseMs: 50, referenceMaxAttempts: 3 });
});
afterAll(async () => {
  await app.close();
});

async function wallet(balance = '100.00') {
  const playerId = newPlayerId();
  const view = await app.openWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
    correlationId: 'test',
  });
  return { walletId: view.id, playerId };
}

async function submit(payload: Record<string, unknown>, key?: string): Promise<WagerResult> {
  const p = payload as unknown as SubmitWagerPayload;
  const outcome = await app.processWager.execute({
    idempotencyKey: key ?? `${p.providerId}:${p.externalTransactionId}`,
    payload: p,
    source: { type: 'http' },
    correlationId: 'test',
  });
  if (outcome.type !== 'result') throw new Error('unexpected duplicate_message');
  return outcome;
}

describe('Criação de wallet', () => {
  test('saldo inicial gera OPENING + CREDIT + 2 eventos na outbox, na mesma transação', async () => {
    const { walletId } = await wallet('1000.00');
    const view = await app.queries.getWallet(walletId);
    expect(view.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(view.version).toBe(1);

    const ledger = await app.queries.getLedger(walletId, undefined, 50);
    expect(ledger.items).toHaveLength(1);
    expect(ledger.items[0]!.direction).toBe('CREDIT');

    const [opening] = await app.sql<{ kind: string; status: string }>(
      'select kind, status from wager_transaction where wallet_id = ?',
      [walletId],
    );
    expect(opening).toEqual({ kind: 'OPENING', status: 'PROCESSED' });

    const events = await app.sql<{ event_type: string }>(
      'select event_type from outbox_message where aggregate_id = ? order by event_type',
      [walletId],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  test('wallet duplicada para o mesmo player + moeda é conflito', async () => {
    const { playerId } = await wallet('10.00');
    await expect(
      app.openWallet.execute({ playerId, initialBalance: { amount: '5.00', currency: 'BRL' }, correlationId: 't' }),
    ).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });

  test('saldo inicial zero não gera ledger', async () => {
    const { walletId } = await wallet('0.00');
    expect((await app.queries.getLedger(walletId, undefined, 50)).items).toHaveLength(0);
  });
});

describe('Idempotência persistente', () => {
  test('requisição idêntica → mesma resposta com idempotentReplay=true e um único débito', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const payload = betPayload(walletId, playerId, '25.00');
    const first = await submit(payload);
    const second = await submit(payload);
    expect(first).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
    expect(second).toEqual({ ...first, idempotentReplay: true });
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('75.00');
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('replay devolve o saldo OBSERVADO NAQUELE MOMENTO, não o atual', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const first = betPayload(walletId, playerId, '10.00');
    await submit(first);
    await submit(betPayload(walletId, playerId, '30.00'));
    const replay = await submit(first);
    expect(replay.balance?.amount).toBe('90.00');
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('60.00');
  });

  test('mesma key com payload diferente → conflito (não é replay) e nada muda', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const payload = betPayload(walletId, playerId, '25.00');
    await submit(payload);
    await expect(submit({ ...payload, money: { amount: '30.00', currency: 'BRL' } })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('75.00');
  });

  test('replay de rejeição devolve a mesma rejeição', async () => {
    const { walletId, playerId } = await wallet('10.00');
    const payload = betPayload(walletId, playerId, '20.00');
    const first = await submit(payload);
    const second = await submit(payload);
    expect(first).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: false });
    expect(second).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', idempotentReplay: true });
  });
});

describe('Regras de negócio com banco real', () => {
  test('OPENING não pode ser submetido', async () => {
    const { walletId, playerId } = await wallet();
    await expect(submit(betPayload(walletId, playerId, '1.00', { kind: 'OPENING' }))).rejects.toBeInstanceOf(ValidationError);
  });

  test('LOSS: PROCESSED, sem ledger, saldo e version intactos, evento Processed sem BalanceChanged', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const result = await submit(betPayload(walletId, playerId, '0.00', { kind: 'LOSS' }));
    expect(String(result.status)).toBe('PROCESSED');
    const view = await app.queries.getWallet(walletId);
    expect(view.version).toBe(1);
    const events = await app.sql<{ event_type: string }>(
      `select event_type from outbox_message where payload->'data'->>'transactionId' = ?`,
      [result.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionProcessed']);
  });

  test('REFUND reverte BET uma única vez; segunda reversão → ALREADY_REVERSED', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bet = betPayload(walletId, playerId, '40.00');
    await submit(bet);
    const refund = await submit(
      betPayload(walletId, playerId, '40.00', { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const rollback = await submit(
      betPayload(walletId, playerId, '40.00', { kind: 'ROLLBACK', referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'ALREADY_REVERSED' });
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('ROLLBACK de WIN já gasto → REVERSAL_INSUFFICIENT_FUNDS (auditável)', async () => {
    const { walletId, playerId } = await wallet('20.00');
    const win = betPayload(walletId, playerId, '50.00', { kind: 'WIN' });
    await submit(win);
    await submit(betPayload(walletId, playerId, '60.00'));
    const rb = await submit(
      betPayload(walletId, playerId, '50.00', { kind: 'ROLLBACK', referenceExternalTransactionId: win.externalTransactionId }),
    );
    expect(rb).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    const [row] = await app.sql<{ status: string }>('select status from wager_transaction where id = ?', [rb.transactionId]);
    expect(row!.status).toBe('REJECTED');
  });

  test('wallet inexistente → REJECTED/WALLET_NOT_FOUND', async () => {
    const result = await submit(betPayload(Bun.randomUUIDv7(), newPlayerId(), '1.00'));
    expect(result).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND', transactionId: null });
  });
});

describe('Referência fora de ordem', () => {
  test('REFUND antes da BET → PENDING_REFERENCE; BET chega; worker aplica', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const bet = betPayload(walletId, playerId, '30.00');
    const refund = await submit(
      betPayload(walletId, playerId, '30.00', { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(String(refund.status)).toBe('PENDING_REFERENCE');

    await submit(bet); // 70 — e "acorda" o REFUND pendente
    await app.resolvePending.runOnce();

    const tx = await app.queries.getTransaction(refund.transactionId!);
    expect(tx.status).toBe('PROCESSED');
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('100.00');
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('referência que nunca chega → REJECTED/REFERENCE_NOT_FOUND + evento Rejected', async () => {
    const { walletId, playerId } = await wallet('100.00');
    const rb = await submit(
      betPayload(walletId, playerId, '10.00', { kind: 'ROLLBACK', referenceExternalTransactionId: 'ghost' }),
    );
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(150);
      await app.resolvePending.runOnce();
      const tx = await app.queries.getTransaction(rb.transactionId!);
      if (tx.status !== 'PENDING_REFERENCE') break;
    }
    const tx = await app.queries.getTransaction(rb.transactionId!);
    expect(tx).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    const events = await app.sql<{ event_type: string }>(
      `select event_type from outbox_message where payload->'data'->>'transactionId' = ? order by occurred_at`,
      [rb.transactionId],
    );
    expect(events.map((e) => e.event_type)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });
});

describe('Paginação do ledger', () => {
  test('cursor opaco e estável: percorre tudo sem pular nem repetir', async () => {
    const { walletId, playerId } = await wallet('100.00');
    for (let i = 0; i < 7; i++) await submit(betPayload(walletId, playerId, '1.00'));
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = await app.queries.getLedger(walletId, cursor, 3);
      seen.push(...page.items.map((i) => i.walletVersion));
      cursor = page.nextCursor ?? undefined;
      if (cursor) await submit(betPayload(walletId, playerId, '1.00')); // novos lançamentos durante a paginação
    } while (cursor);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen[0]).toBe(1);
  });
});
