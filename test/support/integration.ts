import { MikroORM } from '@mikro-orm/postgresql';
import { noopLogger, noopMetrics } from '../../src/application/observability';
import { ProcessWagerTransactionUseCase } from '../../src/application/wagering/process-wager-transaction.use-case';
import { ResolvePendingReferencesUseCase } from '../../src/application/wagering/resolve-pending-references.use-case';
import { OpenWalletUseCase } from '../../src/application/wallets/open-wallet.use-case';
import { ReconcileWalletUseCase } from '../../src/application/wallets/reconcile-wallet.use-case';
import { WageringQueries } from '../../src/application/queries/queries';
import { ExponentialBackoff } from '../../src/domain/shared/exponential-backoff';
import { buildOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { MikroOrmTransactionRunner } from '../../src/infrastructure/persistence/mikro-orm-transaction-runner';
import { SystemClock, UuidV7Generator } from '../../src/infrastructure/support/system';

/**
 * Infra REAL para testes de integração: PostgreSQL de verdade (nada de mock).
 *   TEST_DATABASE_URL (padrão: banco "wagering_test" no Postgres do docker compose)
 */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/wagering_test';

/** Apaga e recria o schema e roda as migrations do zero. */
export async function resetDatabase(url = TEST_DATABASE_URL): Promise<void> {
  const orm = await MikroORM.init(buildOrmConfig({ databaseUrl: url, poolMax: 2 }));
  try {
    await orm.em.fork().execute('drop schema public cascade; create schema public;');
    await orm.getMigrator().up();
  } finally {
    await orm.close(true);
  }
}

export interface TestApp {
  orm: MikroORM;
  runner: MikroOrmTransactionRunner;
  processWager: ProcessWagerTransactionUseCase;
  openWallet: OpenWalletUseCase;
  reconcile: ReconcileWalletUseCase;
  resolvePending: ResolvePendingReferencesUseCase;
  queries: WageringQueries;
  sql: <T = Record<string, unknown>>(query: string, params?: unknown[]) => Promise<T[]>;
  close: () => Promise<void>;
}

export async function createTestApp(options: { poolMax?: number; referenceBaseMs?: number; referenceMaxAttempts?: number } = {}): Promise<TestApp> {
  const orm = await MikroORM.init(buildOrmConfig({ databaseUrl: TEST_DATABASE_URL, poolMax: options.poolMax ?? 30 }));
  const runner = new MikroOrmTransactionRunner(orm, { lockTimeoutMs: 10_000, statementTimeoutMs: 20_000 }, noopMetrics, noopLogger);
  const ids = new UuidV7Generator();
  const clock = new SystemClock();
  const settings = {
    referenceBackoff: new ExponentialBackoff(options.referenceBaseMs ?? 50, 1_000),
    referenceMaxAttempts: options.referenceMaxAttempts ?? 5,
  };
  return {
    orm,
    runner,
    processWager: new ProcessWagerTransactionUseCase(runner, ids, clock, settings, noopMetrics, noopLogger),
    openWallet: new OpenWalletUseCase(runner, ids, clock, noopLogger),
    reconcile: new ReconcileWalletUseCase(runner, noopMetrics, noopLogger),
    resolvePending: new ResolvePendingReferencesUseCase(runner, ids, clock, settings, noopMetrics, noopLogger),
    queries: new WageringQueries(runner),
    sql: <T>(query: string, params: unknown[] = []) => orm.em.fork().execute(query, params) as Promise<T[]>,
    close: () => orm.close(true),
  };
}

export const newPlayerId = () => Bun.randomUUIDv7();

let extSeq = 0;
export function betPayload(walletId: string, playerId: string, amount: string, overrides: Record<string, unknown> = {}) {
  const externalTransactionId = (overrides.externalTransactionId as string) ?? `tx-${Date.now()}-${++extSeq}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
    ...overrides,
  };
}

/** A invariante final exigida pela seção 13: saldo da wallet == saldo reconstruído pelo ledger. */
export async function assertLedgerMatchesBalance(app: TestApp, walletId: string): Promise<void> {
  const report = await app.reconcile.execute(walletId);
  if (!report.consistent) {
    throw new Error(`Ledger mismatch for ${walletId}: ${JSON.stringify(report)}`);
  }
}
