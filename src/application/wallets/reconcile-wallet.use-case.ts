import type { MoneyProps } from '../../domain/money/money';
import { NotFoundError } from '../errors';
import type { AppLogger, Metrics } from '../observability';
import type { TransactionRunner } from '../ports';

export interface ReconciliationReport {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo materializado (coluna `balance_amount`) com o saldo reconstruído
 * pelo ledger (Σ créditos − Σ débitos).
 *
 * A wallet é lida com FOR SHARE: bloqueia escritas nela durante a leitura, então
 * saldo e ledger são lidos no mesmo instante lógico (sem falso alarme por corrida).
 *
 * Divergência NÃO é corrigida: é logada como erro, contabilizada em métrica e
 * sinalizada na resposta (`consistent: false`). Corrigir automaticamente esconderia um bug.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly runner: TransactionRunner,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationReport> {
    const report = await this.runner.run(async (uow) => {
      const wallet = await uow.wallets.findByIdForShare(walletId);
      if (!wallet) throw new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} not found`);
      const totals = await uow.ledger.totals(walletId, wallet.currency);
      const difference = wallet.balance.subtract(totals.sum);
      return {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: totals.sum.toJSON(),
        difference: difference.toJSON(),
        consistent: difference.isZero(),
        checkedEntries: totals.count,
      };
    });

    this.metrics.reconciliationChecked(report.consistent);
    if (!report.consistent) {
      this.logger.error('wallet reconciliation mismatch', {
        walletId,
        storedBalance: report.storedBalance.amount,
        calculatedBalance: report.calculatedBalance.amount,
        difference: report.difference.amount,
      });
    }
    return report;
  }
}
