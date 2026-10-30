import { Money, type MoneyProps } from '../money/money';
import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { InvariantViolationError, ValidationError } from '../shared/domain-error';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  Opening = 'OPENING', // interno: crédito de abertura da wallet
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING', // aceita, ainda não aplicada (só existe dentro da transação SQL)
  PendingReference = 'PENDING_REFERENCE', // aguardando a transação referenciada
  Processed = 'PROCESSED', // aplicada (terminal)
  Rejected = 'REJECTED', // violação de regra de negócio (terminal)
  Failed = 'FAILED', // erro permanente de infraestrutura (terminal, auditável)
}

/** Tipos que o provedor pode enviar. OPENING fica de fora: é interno. */
export const EXTERNAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/**
 * Máquina de estados (transições válidas). Também documentada em ARCHITECTURE.md
 * e reforçada no banco por trigger.
 *
 *   PENDING ──────────► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE ─► PROCESSED | REJECTED | FAILED | PENDING_REFERENCE (nova tentativa agendada)
 *   PROCESSED / REJECTED / FAILED ─► (nenhuma — terminais)
 */
const ALLOWED_TRANSITIONS: Readonly<Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
    WagerTransactionStatus.PendingReference,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

/** Transição inválida = erro de PROGRAMAÇÃO, não caminho de negócio. */
export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(id: string, from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`Invalid transition for transaction ${id}: ${from} -> ${to}`);
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  resultingBalance?: MoneyProps;
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

/**
 * Uma operação recebida de um provedor (ou a OPENING interna).
 *
 * Campos imutáveis são `readonly`; o estado que muda (status, failureCode...)
 * é privado e só muda pelos métodos de transição, que validam a máquina de estados.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    /** Saldo da wallet observado no momento da decisão — devolvido em replays. */
    private _resultingBalance?: Money,
    private _referenceAttempts: number = 0,
    private _nextReferenceAttemptAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. Não aceita OPENING. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!EXTERNAL_KINDS.includes(props.kind)) {
      throw new ValidationError('KIND_NOT_ALLOWED', `Kind "${props.kind}" cannot be submitted by providers`);
    }
    return WagerTransaction.build(props);
  }

  /** Factory INTERNA para o crédito de abertura da wallet. Só a camada de aplicação a usa. */
  static createOpening(props: Omit<CreateWagerTransactionProps, 'kind' | 'referenceExternalTransactionId'>): WagerTransaction {
    return WagerTransaction.build({ ...props, kind: WagerTransactionKind.Opening });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      Money.rehydrate(state.money),
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultingBalance ? Money.rehydrate(state.resultingBalance) : undefined,
      state.referenceAttempts,
      state.nextReferenceAttemptAt,
    );
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    for (const field of ['providerId', 'externalTransactionId', 'idempotencyKey', 'walletId', 'playerId', 'roundId', 'gameId'] as const) {
      if (!props[field] || props[field].trim() === '') {
        throw new ValidationError('INVALID_PAYLOAD', `Field "${field}" is required`);
      }
    }

    const requiresReference = props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    const ref = props.referenceExternalTransactionId;
    if (requiresReference && (!ref || ref.trim() === '')) {
      throw new ValidationError('REFERENCE_REQUIRED', `${props.kind} requires referenceExternalTransactionId`);
    }
    const referenceNotAllowed = props.kind === WagerTransactionKind.Bet || props.kind === WagerTransactionKind.Opening;
    if (referenceNotAllowed && ref !== undefined) {
      throw new ValidationError('REFERENCE_NOT_ALLOWED', `${props.kind} cannot reference another transaction`);
    }
    if (ref !== undefined && ref === props.externalTransactionId) {
      throw new ValidationError('INVALID_REFERENCE', 'A transaction cannot reference itself');
    }

    // LOSS registra um resultado e pode vir com valor zero; todas as outras movimentam dinheiro.
    const zeroAllowed = props.kind === WagerTransactionKind.Loss;
    if (props.money.isNegative() || (!zeroAllowed && props.money.isZero())) {
      throw new ValidationError('INVALID_MONEY', `${props.kind} amount must be ${zeroAllowed ? 'non-negative' : 'positive'}`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      ref,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  // ---- transições ---------------------------------------------------------

  markProcessed(referenceTransactionId: string | undefined, at: Date, resultingBalance: Money): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._resultingBalance = resultingBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** Primeira vez que a referência não foi encontrada. */
  markPendingReference(nextAttemptAt: Date, observedBalance: Money): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this.id, this._status, WagerTransactionStatus.PendingReference);
    }
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = nextAttemptAt;
    this._resultingBalance = observedBalance;
  }

  /** Nova tentativa falhou: agenda a próxima (o worker calcula o backoff). */
  scheduleReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this.id, this._status, WagerTransactionStatus.PendingReference);
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  reject(code: FailureCode, observedBalance?: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
    if (observedBalance) this._resultingBalance = observedBalance;
  }

  fail(code: FailureCode): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio -----------------------------------------------

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  /** false para LOSS: registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK. */
  requiresReference(): boolean {
    return this.isReversal();
  }

  isReversal(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento que esta transação gera:
   *   OPENING, WIN, REFUND → CREDIT
   *   BET                  → DEBIT
   *   ROLLBACK             → inverso da direção da referência
   *   LOSS                 → não gera lançamento (erro chamar)
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvariantViolationError('ROLLBACK direction requires the referenced transaction');
        }
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Credit ? LedgerDirection.Debit : LedgerDirection.Credit;
      }
      case WagerTransactionKind.Loss:
        throw new InvariantViolationError('LOSS does not produce ledger entries');
    }
  }

  toState(): WagerTransactionState {
    return {
      id: this.id,
      providerId: this.providerId,
      externalTransactionId: this.externalTransactionId,
      idempotencyKey: this.idempotencyKey,
      payloadHash: this.payloadHash,
      walletId: this.walletId,
      playerId: this.playerId,
      roundId: this.roundId,
      gameId: this.gameId,
      kind: this.kind,
      money: this.money.toJSON(),
      referenceExternalTransactionId: this.referenceExternalTransactionId,
      correlationId: this.correlationId,
      createdAt: this.createdAt,
      status: this._status,
      referenceTransactionId: this._referenceTransactionId,
      failureCode: this._failureCode,
      processedAt: this._processedAt,
      resultingBalance: this._resultingBalance?.toJSON(),
      referenceAttempts: this._referenceAttempts,
      nextReferenceAttemptAt: this._nextReferenceAttemptAt,
    };
  }

  private transitionTo(next: WagerTransactionStatus): void {
    if (!ALLOWED_TRANSITIONS[this._status].includes(next)) {
      throw new InvalidTransactionStateError(this.id, this._status, next);
    }
    this._status = next;
  }
}
