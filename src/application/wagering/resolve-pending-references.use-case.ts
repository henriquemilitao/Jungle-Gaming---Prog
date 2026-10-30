import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { WagerTransactionProcessor } from '../../domain/wagering/wager-transaction-processor';
import { TransientInfrastructureError } from '../errors';
import type { AppLogger, Metrics } from '../observability';
import type { Clock, IdGenerator, TransactionRunner } from '../ports';
import { lookupReference, persistOutcome, type WageringSettings } from './process-wager-transaction.use-case';

export interface ResolveSummary {
  checked: number;
  processed: number;
  rejected: number;
  stillPending: number;
  failed: number;
}

/**
 * Reprocessa transações PENDING_REFERENCE vencidas (seção 7.1).
 *
 * Executado periodicamente pelo worker agendado, em TODAS as instâncias. É seguro rodar
 * em paralelo: cada transação é reprocessada com a wallet TRAVADA (mesma ordem de lock
 * do fluxo principal: wallet → transação), e o status é rechecado depois do lock — se outra
 * instância já resolveu, esta simplesmente pula.
 *
 * Backoff exponencial entre tentativas; ao esgotar o limite → REJECTED/REFERENCE_NOT_FOUND
 * + evento WagerTransactionRejected.
 */
export class ResolvePendingReferencesUseCase {
  private readonly processor = new WagerTransactionProcessor();

  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settings: WageringSettings,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async runOnce(batchSize = 50): Promise<ResolveSummary> {
    const summary: ResolveSummary = { checked: 0, processed: 0, rejected: 0, stillPending: 0, failed: 0 };
    const due = await this.runner.run((uow) => uow.transactions.findDuePendingReferences(this.clock.now(), batchSize));

    for (const candidate of due) {
      summary.checked++;
      try {
        const status = await this.resolveOne(candidate.id, candidate.walletId);
        if (status === WagerTransactionStatus.Processed) summary.processed++;
        else if (status === WagerTransactionStatus.Rejected) summary.rejected++;
        else if (status === WagerTransactionStatus.PendingReference) summary.stillPending++;
      } catch (err) {
        if (err instanceof TransientInfrastructureError) {
          // Banco instável: fica PENDING_REFERENCE e o próximo ciclo tenta de novo.
          this.logger.warn('pending reference retry deferred (transient error)', { transactionId: candidate.id, code: err.code });
          continue;
        }
        summary.failed++;
        await this.markFailed(candidate.id, candidate.walletId, err);
      }
    }
    return summary;
  }

  private resolveOne(transactionId: string, walletId: string): Promise<WagerTransactionStatus | 'skipped'> {
    return this.runner.run(async (uow) => {
      const now = this.clock.now();
      const wallet = await uow.wallets.findByIdForUpdate(walletId);
      const tx = await uow.transactions.findById(transactionId);
      if (!wallet || !tx) return 'skipped';
      // Outra instância pode ter resolvido enquanto esperávamos o lock.
      if (tx.status !== WagerTransactionStatus.PendingReference) return 'skipped';
      if (tx.nextReferenceAttemptAt && tx.nextReferenceAttemptAt > now) return 'skipped';

      this.metrics.retry('pending_reference');
      const lookup = await lookupReference(uow, tx);
      const outcome = this.processor.process(tx, wallet, lookup, {
        now,
        ledgerEntryId: this.ids.next(),
        referenceBackoff: this.settings.referenceBackoff,
        referenceMaxAttempts: this.settings.referenceMaxAttempts,
      });

      await uow.transactions.update(tx);
      await persistOutcome(
        uow,
        tx,
        wallet,
        outcome,
        { newId: () => this.ids.next(), correlationId: tx.correlationId, causationId: tx.id, occurredAt: now },
        { emitPendingEvent: false }, // o evento de "pending" já foi emitido quando entrou em espera
      );

      if (outcome.type !== 'pending_reference') {
        this.metrics.transactionFinished(tx.status, tx.kind, 'pending_reference_worker');
        this.logger.info('pending reference resolved', {
          transactionId: tx.id,
          walletId: tx.walletId,
          status: tx.status,
          failureCode: tx.failureCode,
          attempts: tx.referenceAttempts,
        });
      }
      return tx.status;
    });
  }

  /** Erro permanente e inesperado: registra FAILED (terminal, auditável) em vez de tentar para sempre. */
  private async markFailed(transactionId: string, walletId: string, cause: unknown): Promise<void> {
    this.logger.error('pending reference processing failed permanently', {
      transactionId,
      walletId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    try {
      await this.runner.run(async (uow) => {
        await uow.wallets.findByIdForUpdate(walletId);
        const tx = await uow.transactions.findById(transactionId);
        if (!tx || tx.status !== WagerTransactionStatus.PendingReference) return;
        tx.fail(FailureCode.ProcessingFailed);
        await uow.transactions.update(tx);
      });
      this.metrics.transactionFinished(WagerTransactionStatus.Failed, 'unknown', 'pending_reference_worker');
    } catch (err) {
      this.logger.error('could not mark transaction as FAILED', { transactionId, error: String(err) });
    }
  }
}
