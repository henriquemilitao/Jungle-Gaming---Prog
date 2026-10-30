import type { MoneyProps } from '../../domain/money/money';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wagering/wager-transaction';

/**
 * Resultado do processamento de uma operação — o mesmo para HTTP e SQS.
 * `idempotentReplay = true` quando a operação já existia e devolvemos o resultado ORIGINAL.
 */
export interface WagerResult {
  type: 'result';
  transactionId: string | null;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

/** A mensagem SQS já tinha sido processada (inbox). Nada a fazer além do ack. */
export interface DuplicateMessage {
  type: 'duplicate_message';
}

export type WagerOutcome = WagerResult | DuplicateMessage;

export function resultFrom(tx: WagerTransaction, idempotentReplay: boolean): WagerResult {
  const result: WagerResult = {
    type: 'result',
    transactionId: tx.id,
    status: tx.status,
    balance: tx.resultingBalance?.toJSON() ?? null,
    idempotentReplay,
  };
  if (tx.failureCode) result.failureCode = tx.failureCode;
  return result;
}

/** walletId inexistente: não há como persistir (FK), mas a rejeição é estável e determinística. */
export function walletNotFoundResult(): WagerResult {
  return {
    type: 'result',
    transactionId: null,
    status: WagerTransactionStatus.Rejected,
    balance: null,
    failureCode: FailureCode.WalletNotFound,
    idempotentReplay: false,
  };
}
