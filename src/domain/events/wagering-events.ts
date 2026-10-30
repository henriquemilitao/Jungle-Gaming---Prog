import type { MoneyProps } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { InvariantViolationError } from '../shared/domain-error';
import { FailureCode } from '../wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../wagering/wager-transaction';
import { Wallet } from '../wallet/wallet';
import { IntegrationEvent, type EventContext, type IntegrationEventProps } from './integration-event';

/*
 * Os 4 eventos mínimos da seção 11.
 *
 * aggregateId = walletId em TODOS: a wallet é a unidade de concorrência, e
 * publicar com MessageGroupId = walletId preserva a ordem por wallet na fila FIFO.
 * O transactionId vai dentro de `data`.
 *
 * `data` carrega MoneyProps (string), nunca a instância de Money.
 */

interface TransactionSummary {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function summarize(tx: WagerTransaction): TransactionSummary {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus): void {
  if (tx.status !== expected) {
    throw new InvariantViolationError(`Cannot emit event for ${tx.id}: expected ${expected}, got ${tx.status}`);
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionSummary {
  referenceTransactionId?: string;
  balance: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (que não move saldo) e OPENING. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed);
    const data: WagerTransactionProcessedData = {
      ...summarize(tx),
      balance: tx.resultingBalance!.toJSON(),
      processedAt: tx.processedAt!.toISOString(),
    };
    if (tx.referenceTransactionId) data.referenceTransactionId = tx.referenceTransactionId;
    return new WagerTransactionProcessed(IntegrationEvent.propsFrom(tx.walletId, data, ctx));
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends TransactionSummary {
  failureCode: FailureCode;
  referenceExternalTransactionId?: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected);
    const data: WagerTransactionRejectedData = { ...summarize(tx), failureCode: tx.failureCode! };
    if (tx.referenceExternalTransactionId) data.referenceExternalTransactionId = tx.referenceExternalTransactionId;
    return new WagerTransactionRejected(IntegrationEvent.propsFrom(tx.walletId, data, ctx));
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends TransactionSummary {
  referenceExternalTransactionId: string;
  nextAttemptAt: string;
}

/** Emitido quando a transação entra em PENDING_REFERENCE (referência ainda ausente). */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
    super(props);
  }

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference);
    const data: WagerTransactionPendingReferenceData = {
      ...summarize(tx),
      referenceExternalTransactionId: tx.referenceExternalTransactionId!,
      nextAttemptAt: tx.nextReferenceAttemptAt!.toISOString(),
    };
    return new WagerTransactionPendingReference(IntegrationEvent.propsFrom(tx.walletId, data, ctx));
  }
}

// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** SOMENTE quando o saldo muda — por isso é construído a partir do lançamento do ledger. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvariantViolationError('Ledger entry does not belong to wallet');
    }
    const data: WalletBalanceChangedData = {
      walletId: wallet.id,
      transactionId: entry.transactionId,
      direction: entry.direction,
      money: entry.money.toJSON(),
      balanceBefore: entry.balanceBefore.toJSON(),
      balanceAfter: entry.balanceAfter.toJSON(),
      walletVersion: entry.walletVersion,
    };
    return new WalletBalanceChanged(IntegrationEvent.propsFrom(wallet.id, data, ctx));
  }
}
