import { WalletLedgerEntry, LedgerDirection } from '../ledger/wallet-ledger-entry';
import { ExponentialBackoff } from '../shared/exponential-backoff';
import { InvariantViolationError } from '../shared/domain-error';
import { Wallet } from '../wallet/wallet';
import { FailureCode } from './failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from './wager-transaction';

/** Tipos que cada operação pode referenciar (seção 7, regra 3). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund],
  // WIN/LOSS: referência OPCIONAL; quando informada, deve ser a BET da rodada.
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Loss]: [WagerTransactionKind.Bet],
};

export interface ReferenceLookup {
  /**
   * - `undefined`: a transação não referencia nada;
   * - `null`: referencia, mas a referência ainda não existe (fora de ordem);
   * - instância: a referência encontrada por (providerId, referenceExternalTransactionId).
   */
  reference: WagerTransaction | null | undefined;
  /** A referência já possui uma reversão (REFUND/ROLLBACK) PROCESSED? */
  alreadyReversed: boolean;
}

export interface ProcessContext {
  now: Date;
  /** id do lançamento, caso a operação mova saldo (gerado fora do domínio). */
  ledgerEntryId: string;
  referenceBackoff: ExponentialBackoff;
  referenceMaxAttempts: number;
}

export type ProcessOutcome =
  | { type: 'processed'; ledgerEntry?: WalletLedgerEntry }
  | { type: 'rejected'; code: FailureCode }
  | { type: 'pending_reference' };

/**
 * Domain Service com TODAS as regras de negócio da seção 7.
 *
 * É código puro: recebe a wallet (já TRAVADA pela infraestrutura), a transação
 * e a referência já buscada; decide e aplica. Não sabe nada de banco ou fila,
 * por isso é testado com testes unitários simples.
 *
 * A mesma função é usada pela entrada HTTP, pelo consumidor SQS e pelo worker
 * que reprocessa PENDING_REFERENCE — uma única fonte de verdade.
 */
export class WagerTransactionProcessor {
  process(tx: WagerTransaction, wallet: Wallet, lookup: ReferenceLookup, ctx: ProcessContext): ProcessOutcome {
    if (tx.isTerminal()) {
      throw new InvariantViolationError(`Transaction ${tx.id} is already ${tx.status}`);
    }
    if (tx.walletId !== wallet.id) {
      throw new InvariantViolationError('Transaction and wallet do not match');
    }

    // 1. A wallet pertence ao player e está na mesma moeda?
    if (tx.playerId !== wallet.playerId) {
      return this.reject(tx, wallet, FailureCode.PlayerMismatch);
    }
    if (tx.money.currency !== wallet.currency) {
      return this.reject(tx, wallet, FailureCode.CurrencyMismatch);
    }

    // 2. Referência (obrigatória para REFUND/ROLLBACK, opcional para WIN/LOSS).
    let reference: WagerTransaction | undefined;
    if (tx.referenceExternalTransactionId !== undefined) {
      const found = lookup.reference;
      // Referência ainda não chegou (ou chegou mas também está aguardando a dela) → esperar.
      if (found === null || found === undefined || found.status === WagerTransactionStatus.PendingReference) {
        return this.waitForReference(tx, wallet, ctx);
      }
      const problem = this.validateReference(tx, found, lookup.alreadyReversed);
      if (problem) return this.reject(tx, wallet, problem);
      reference = found;
    }

    // 3. LOSS: registra o resultado, sem ledger e sem mexer no saldo.
    if (!tx.affectsBalance()) {
      tx.markProcessed(reference?.id, ctx.now, wallet.balance);
      return { type: 'processed' };
    }

    // 4. Movimenta o saldo.
    const direction = tx.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
      // Códigos DISTINTOS: aposta sem saldo ≠ reversão que deixaria saldo negativo.
      const code = tx.isReversal() ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds;
      return this.reject(tx, wallet, code);
    }

    const ledgerRef = { transactionId: tx.id, ledgerEntryId: ctx.ledgerEntryId, at: ctx.now };
    const ledgerEntry =
      direction === LedgerDirection.Debit ? wallet.debit(tx.money, ledgerRef) : wallet.credit(tx.money, ledgerRef);

    tx.markProcessed(reference?.id, ctx.now, wallet.balance);
    return { type: 'processed', ledgerEntry };
  }

  /** Regras 2, 3, 4 e 5 da seção 7. Devolve o código de falha ou undefined se válida. */
  private validateReference(tx: WagerTransaction, ref: WagerTransaction, alreadyReversed: boolean): FailureCode | undefined {
    const sameContext =
      ref.providerId === tx.providerId &&
      ref.playerId === tx.playerId &&
      ref.walletId === tx.walletId &&
      ref.money.currency === tx.money.currency &&
      ref.roundId === tx.roundId;
    if (!sameContext) return FailureCode.ReferenceMismatch;

    const allowed = ALLOWED_REFERENCE_KINDS[tx.kind] ?? [];
    if (!allowed.includes(ref.kind)) return FailureCode.InvalidReferenceKind;

    if (ref.status !== WagerTransactionStatus.Processed) return FailureCode.ReferenceNotProcessed;

    if (tx.isReversal()) {
      if (!ref.money.equals(tx.money)) return FailureCode.ReversalAmountMismatch;
      if (alreadyReversed) return FailureCode.AlreadyReversed;
    }
    return undefined;
  }

  private waitForReference(tx: WagerTransaction, wallet: Wallet, ctx: ProcessContext): ProcessOutcome {
    if (tx.status === WagerTransactionStatus.Pending) {
      tx.markPendingReference(ctx.referenceBackoff.nextAttemptAt(ctx.now, 0), wallet.balance);
      return { type: 'pending_reference' };
    }
    // Já estava PENDING_REFERENCE: esta foi mais uma tentativa sem sucesso.
    const attemptsSoFar = tx.referenceAttempts + 1;
    if (attemptsSoFar >= ctx.referenceMaxAttempts) {
      return this.reject(tx, wallet, FailureCode.ReferenceNotFound);
    }
    tx.scheduleReferenceRetry(ctx.referenceBackoff.nextAttemptAt(ctx.now, attemptsSoFar));
    return { type: 'pending_reference' };
  }

  private reject(tx: WagerTransaction, wallet: Wallet, code: FailureCode): ProcessOutcome {
    tx.reject(code, wallet.balance);
    return { type: 'rejected', code };
  }
}
