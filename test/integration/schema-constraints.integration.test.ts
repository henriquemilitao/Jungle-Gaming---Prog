import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money/money';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { betPayload, createTestApp, newPlayerId, resetDatabase, TEST_DATABASE_URL, type TestApp } from '../support/integration';

/**
 * As garantias estão NO BANCO, não só no código (seção 5, item 9).
 * Aqui ignoramos a aplicação e tentamos quebrar as regras com SQL direto.
 */
let app: TestApp;

beforeAll(async () => {
  await resetDatabase();
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

async function newWallet(balance = '100.00') {
  const playerId = newPlayerId();
  const view = await app.openWallet.execute({ playerId, initialBalance: { amount: balance, currency: 'BRL' }, correlationId: 't' });
  return { walletId: view.id, playerId };
}

/** Executa SQL numa transação própria e devolve a mensagem de erro (ou null se passou). */
async function tryInTransaction(statements: string[], params: unknown[][] = []): Promise<string | null> {
  try {
    await app.orm.em.fork().transactional(async (em) => {
      for (const [i, sql] of statements.entries()) await em.execute(sql, params[i] ?? []);
    });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

describe('Migrations', () => {
  test('são reversíveis: down remove tudo e up recria', async () => {
    const orm = await MikroORM.init(buildOrmConfig({ databaseUrl: TEST_DATABASE_URL, poolMax: 2 }));
    try {
      const migrator = orm.getMigrator();
      expect((await migrator.getExecutedMigrations()).length).toBe(1);
      await migrator.down();
      const tables = await orm.em.fork().execute(`select tablename from pg_tables where schemaname = 'public'`);
      expect(tables.map((t) => t.tablename)).toEqual(['mikro_orm_migrations']);
      await migrator.up();
      expect((await migrator.getPendingMigrations()).length).toBe(0);
    } finally {
      await orm.close(true);
    }
  });
});

describe('Não-negatividade', () => {
  test('CHECK impede saldo negativo mesmo via SQL direto', async () => {
    const { walletId } = await newWallet('10.00');
    const error = await tryInTransaction(['update wallet set balance_amount = -1, version = version + 1 where id = ?'], [[walletId]]);
    expect(error).toContain('wallet_balance_non_negative_ck');
  });
});

describe('Saldo ⇄ ledger', () => {
  test('mudar o saldo sem lançamento correspondente é recusado no COMMIT', async () => {
    const { walletId } = await newWallet('10.00');
    const error = await tryInTransaction(['update wallet set balance_amount = 999, version = version + 1 where id = ?'], [[walletId]]);
    expect(error).toContain('without a matching ledger entry');
  });

  test('version só muda junto com o saldo, e de 1 em 1', async () => {
    const { walletId } = await newWallet('10.00');
    expect(await tryInTransaction(['update wallet set version = version + 1 where id = ?'], [[walletId]])).toContain(
      'version may only change',
    );
  });

  test('lançamento com aritmética errada é recusado pelo CHECK', async () => {
    const { walletId } = await newWallet('10.00');
    const [tx] = await app.sql<{ id: string }>('select id from wager_transaction where wallet_id = ?', [walletId]);
    const error = await tryInTransaction(
      [
        `insert into wallet_ledger_entry (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, wallet_version, created_at)
         values (?, ?, ?, 'DEBIT', 5, 'BRL', 10, 4, 99, now())`,
      ],
      [[Bun.randomUUIDv7(), walletId, tx!.id]],
    );
    expect(error).toContain('ledger_balanced_ck');
  });
});

describe('Imutabilidade do ledger', () => {
  test.each([
    ['UPDATE', 'update wallet_ledger_entry set amount = amount + 1'],
    ['DELETE', 'delete from wallet_ledger_entry'],
    ['TRUNCATE', 'truncate wallet_ledger_entry'],
  ])('%s é bloqueado', async (_op, sql) => {
    await newWallet('10.00');
    expect(await tryInTransaction([sql])).toContain('append-only');
  });
});

describe('Unicidade', () => {
  test('uma wallet por player + moeda', async () => {
    const { playerId } = await newWallet('0.00');
    const error = await tryInTransaction(
      [`insert into wallet (id, player_id, currency, balance_amount, version, created_at, updated_at) values (?, ?, 'BRL', 0, 1, now(), now())`],
      [[Bun.randomUUIDv7(), playerId]],
    );
    expect(error).toContain('wallet_player_currency_uq');
  });

  test('idempotency key única e um externalTransactionId por provedor', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const payload = betPayload(walletId, playerId, '1.00');
    const result = await app.processWager.execute({
      idempotencyKey: `provider-a:${payload.externalTransactionId}`,
      payload: payload as never,
      source: { type: 'http' },
      correlationId: 't',
    });
    const dup = (column: string, value: string) =>
      tryInTransaction(
        [
          `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
             round_id, game_id, kind, amount, currency, status, correlation_id, created_at, updated_at, failure_code)
           select ?, provider_id, ${column === 'key' ? `'other-ext'` : 'external_transaction_id'},
                  ${column === 'key' ? 'idempotency_key' : `'other-key'`}, payload_hash, wallet_id, player_id,
                  round_id, game_id, kind, amount, currency, 'REJECTED', correlation_id, now(), now(), 'X'
             from wager_transaction where id = ?`,
        ],
        [[Bun.randomUUIDv7(), value]],
      );
    const id = result.type === 'result' ? result.transactionId! : '';
    expect(await dup('key', id)).toContain('wager_tx_idempotency_key_uq');
    expect(await dup('external', id)).toContain('wager_tx_provider_external_uq');
  });

  test('inbox: (consumer, messageId) único', async () => {
    const insert = `insert into inbox_message (consumer_name, message_id, payload_hash, received_at, processed_at) values ('c', 'm-1', ?, now(), now())`;
    const hash = 'a'.repeat(64);
    expect(await tryInTransaction([insert], [[hash]])).toBeNull();
    expect(await tryInTransaction([insert], [[hash]])).toContain('inbox_message_pk');
  });
});

describe('Máquina de estados no banco', () => {
  test('transação terminal não pode ser alterada nem apagada', async () => {
    const { walletId } = await newWallet('10.00');
    expect(
      await tryInTransaction([`update wager_transaction set status = 'REJECTED', failure_code = 'X' where wallet_id = ?`], [[walletId]]),
    ).toContain('is terminal');
    expect(await tryInTransaction([`delete from wager_transaction where wallet_id = ?`], [[walletId]])).toContain('append-only');
  });

  test('REJECTED exige failure_code', async () => {
    const { walletId } = await newWallet('0.00');
    const error = await tryInTransaction(
      [
        `insert into wager_transaction (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, correlation_id, created_at, updated_at)
         select ?, 'p', 'e-x', 'k-x', ?, id, player_id, 'r', 'g', 'BET', 1, 'BRL', 'REJECTED', 'c', now(), now() from wallet where id = ?`,
      ],
      [[Bun.randomUUIDv7(), 'a'.repeat(64), walletId]],
    );
    expect(error).toContain('wager_tx_failure_code_ck');
  });
});

describe('Atomicidade (wallet + ledger + transação + outbox)', () => {
  test('falha no meio da transação → NADA é gravado', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const before = await app.sql<{ n: number }>(`select count(*)::int as n from outbox_message`);
    await expect(
      app.runner.run(async (uow) => {
        const wallet = (await uow.wallets.findByIdForUpdate(walletId))!;
        const entry = wallet.debit(Money.from({ amount: '50.00', currency: 'BRL' }), {
          transactionId: Bun.randomUUIDv7(), // transação inexistente → FK falha no COMMIT
          ledgerEntryId: Bun.randomUUIDv7(),
          at: new Date(),
        });
        await uow.ledger.append(entry);
        await uow.wallets.update(wallet);
        void playerId;
      }),
    ).rejects.toThrow();
    expect((await app.queries.getWallet(walletId)).balance.amount).toBe('100.00');
    const after = await app.sql<{ n: number }>(`select count(*)::int as n from outbox_message`);
    expect(after[0]!.n).toBe(before[0]!.n);
    expect((await app.queries.getLedger(walletId, undefined, 50)).items).toHaveLength(1); // só a abertura
  });
});
