import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SubmitWagerPayload } from '../../src/application/wagering/process-wager-transaction.use-case';
import type { WagerOutcome } from '../../src/application/wagering/wager-result';
import {
  assertLedgerMatchesBalance,
  betPayload,
  createTestApp,
  newPlayerId,
  resetDatabase,
  type TestApp,
} from '../support/integration';

/**
 * Paralelismo REAL contra o PostgreSQL: dezenas de transações SQL abertas ao
 * mesmo tempo, cada uma em sua própria conexão do pool (nada de mock sequencial).
 * Os testes com 3+ PROCESSOS separados ficam em multi-instance.concurrency.test.ts.
 */
let app: TestApp;

beforeAll(async () => {
  await resetDatabase();
  app = await createTestApp({ poolMax: 60 });
});
afterAll(async () => {
  await app.close();
});

async function newWallet(balance: string) {
  const playerId = newPlayerId();
  const view = await app.openWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' }, correlationId: 't' });
  return { walletId: view.id, playerId };
}

function submit(payload: Record<string, unknown>): Promise<WagerOutcome> {
  const p = payload as unknown as SubmitWagerPayload;
  return app.processWager.execute({
    idempotencyKey: `${p.providerId}:${p.externalTransactionId}`,
    payload: p,
    source: { type: 'http' },
    correlationId: 't',
  });
}

const results = (outcomes: WagerOutcome[]) => outcomes.map((o) => (o.type === 'result' ? o : null)).filter((o) => o !== null);

async function debitCount(walletId: string): Promise<number> {
  const [row] = await app.sql<{ n: number }>(
    `select count(*)::int as n from wallet_ledger_entry where wallet_id = ? and direction = 'DEBIT'`,
    [walletId],
  );
  return row!.n;
}

describe('Concorrência (paralelismo real)', () => {
  test('1. a mesma aposta enviada 50 vezes em paralelo → um único débito', async () => {
    const { walletId, playerId } = await newWallet('1000.00');
    const payload = betPayload(walletId, playerId, '25.00');

    const outcomes = results(await Promise.all(Array.from({ length: 50 }, () => submit(payload))));

    expect(outcomes).toHaveLength(50);
    expect(outcomes.filter((o) => !o.idempotentReplay)).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.transactionId)).size).toBe(1);
    expect(outcomes.every((o) => o.status === 'PROCESSED' && o.balance?.amount === '975.00')).toBe(true);
    expect(await debitCount(walletId)).toBe(1);
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('975.00');
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('2. cenário obrigatório: saldo 100, duas apostas de 80 simultâneas', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const a = betPayload(walletId, playerId, '80.00');
    const b = betPayload(walletId, playerId, '80.00');

    const [ra, rb] = results(await Promise.all([submit(a), submit(b)]));
    const statuses: string[] = [ra!.status, rb!.status].sort();

    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(String([ra, rb].find((r) => r!.status === 'REJECTED')!.failureCode)).toBe('INSUFFICIENT_FUNDS');
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('20.00');
    expect(await debitCount(walletId)).toBe(1);

    // Nenhum retry duplica o débito
    await Promise.all([submit(a), submit(b), submit(a), submit(b)]);
    expect(await debitCount(walletId)).toBe(1);
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('20.00');
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('hot wallet: 40 apostas distintas disputando o mesmo saldo nunca deixam negativo', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const outcomes = results(
      await Promise.all(Array.from({ length: 40 }, () => submit(betPayload(walletId, playerId, '7.00')))),
    );
    const processed = outcomes.filter((o) => o.status === 'PROCESSED').length;
    expect(processed).toBe(14); // floor(100 / 7)
    expect(outcomes.filter((o) => o.status === 'REJECTED').length).toBe(26);
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('2.00');
    await assertLedgerMatchesBalance(app, walletId);
  });

  test('3. wallets distintas são processadas em paralelo (sem lock global)', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => newWallet('100.00')));

    // Segura o lock da wallet 0 por 1,5s numa transação à parte...
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const locker = app.runner.run(async (uow) => {
      await uow.wallets.findByIdForUpdate(wallets[0]!.walletId);
      await held;
    });
    await Bun.sleep(100);

    // ...enquanto as OUTRAS 9 wallets processam normalmente, sem esperar.
    const started = performance.now();
    const outcomes = results(
      await Promise.all(wallets.slice(1).map((w) => submit(betPayload(w.walletId, w.playerId, '10.00')))),
    );
    const elapsedMs = performance.now() - started;
    release();
    await locker;

    expect(outcomes.every((o) => o.status === 'PROCESSED')).toBe(true);
    expect(elapsedMs).toBeLessThan(1_000);
    for (const w of wallets) await assertLedgerMatchesBalance(app, w.walletId);
  });

  test('operações mistas concorrentes na mesma wallet mantêm saldo == ledger', async () => {
    const { walletId, playerId } = await newWallet('500.00');
    const bets = Array.from({ length: 15 }, () => betPayload(walletId, playerId, '10.00'));
    const ops = [
      ...bets.map((b) => submit(b)),
      ...Array.from({ length: 10 }, () => submit(betPayload(walletId, playerId, '5.00', { kind: 'WIN' }))),
      ...Array.from({ length: 5 }, () => submit(betPayload(walletId, playerId, '0.00', { kind: 'LOSS' }))),
      // reversões que podem chegar antes OU depois da aposta referenciada
      ...bets.slice(0, 5).map((b) =>
        submit(betPayload(walletId, playerId, '10.00', { kind: 'REFUND', referenceExternalTransactionId: b.externalTransactionId })),
      ),
    ];
    await Promise.all(ops);
    await app.resolvePending.runOnce(); // resolve REFUNDs que chegaram antes da BET

    const pending = await app.sql<{ n: number }>(
      `select count(*)::int as n from wager_transaction where wallet_id = ? and status = 'PENDING_REFERENCE'`,
      [walletId],
    );
    expect(pending[0]!.n).toBe(0);
    // 500 − 15×10 + 10×5 + 5×10 = 450
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('450.00');
    await assertLedgerMatchesBalance(app, walletId);
  });
});
