import type { MikroORM } from '@mikro-orm/postgresql';
import { ApplicationError, TransientInfrastructureError, UniqueConstraintConflictError } from '../../application/errors';
import type { AppLogger, Metrics } from '../../application/observability';
import type { TransactionRunner, UnitOfWork } from '../../application/ports';
import {
  isDatabaseUnavailable,
  isDeadlock,
  isLockNotAvailable,
  isSerializationFailure,
  isStatementTimeout,
  isUniqueViolation,
  violatedConstraint,
} from './db-errors';
import { MikroOrmUnitOfWork } from './mikro-orm-repositories';

const NON_RETRYABLE_UNIQUE = new Set(['wallet_player_currency_uq']);

export interface TransactionRunnerOptions {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
  maxAttempts?: number;
}

/**
 * Implementação de TransactionRunner com MikroORM.
 *
 * - `em.fork()` → Identity Map NOVO por transação (nada vaza entre requisições).
 * - `em.transactional()` → BEGIN; work; flush do Unit of Work; COMMIT (ou ROLLBACK em erro).
 * - `SET LOCAL lock_timeout` → ninguém espera o lock de uma wallet para sempre; estourou → 503.
 * - Corridas resolvidas pelo banco (unique violation entre duas inserções da mesma key, deadlock)
 *   → a transação inteira é refeita do zero; na nova tentativa a leitura enxerga o vencedor
 *   e devolve replay/conflito. Limite de tentativas para não entrar em loop.
 */
export class MikroOrmTransactionRunner implements TransactionRunner {
  private readonly maxAttempts: number;

  constructor(
    private readonly orm: MikroORM,
    private readonly options: TransactionRunnerOptions,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  async run<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional(async (em) => {
          // Valores inteiros vindos da config (não de input do usuário).
          await em.execute(`set local lock_timeout = ${Math.trunc(this.options.lockTimeoutMs)}`);
          await em.execute(`set local statement_timeout = ${Math.trunc(this.options.statementTimeoutMs)}`);
          return work(new MikroOrmUnitOfWork(em, this.metrics));
        });
      } catch (err) {
        if (err instanceof ApplicationError) throw err;

        const retryable =
          isDeadlock(err) ||
          isSerializationFailure(err) ||
          (isUniqueViolation(err) && !NON_RETRYABLE_UNIQUE.has(violatedConstraint(err) ?? ''));

        if (retryable && attempt < this.maxAttempts) {
          if (isDeadlock(err)) this.metrics.lockConflict('deadlock');
          this.metrics.retry('db_transaction');
          this.logger.warn('retrying database transaction after concurrent conflict', {
            attempt,
            constraint: violatedConstraint(err),
            sqlState: (err as { code?: string }).code,
          });
          continue;
        }
        throw this.translate(err);
      }
    }
  }

  private translate(err: unknown): unknown {
    if (isUniqueViolation(err)) return new UniqueConstraintConflictError(violatedConstraint(err));
    if (isLockNotAvailable(err)) {
      this.metrics.lockConflict('timeout');
      return new TransientInfrastructureError('LOCK_TIMEOUT', 'Timed out waiting for the wallet lock', err);
    }
    if (isDeadlock(err) || isSerializationFailure(err)) {
      return new TransientInfrastructureError('CONCURRENCY_CONFLICT', 'Concurrent update conflict, retry later', err);
    }
    if (isStatementTimeout(err)) {
      return new TransientInfrastructureError('DATABASE_TIMEOUT', 'Database statement timed out', err);
    }
    if (isDatabaseUnavailable(err)) {
      return new TransientInfrastructureError('DATABASE_UNAVAILABLE', 'Database is temporarily unavailable', err);
    }
    return err;
  }
}
