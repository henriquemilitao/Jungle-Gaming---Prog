import { CurrencyMismatchError, Money, type MoneyProps } from '../money/money';
import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { DomainError, InvariantViolationError, ValidationError } from '../shared/domain-error';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(balance: Money, requested: Money) {
    super(`Insufficient funds: balance ${balance}, requested ${requested}`);
  }
}

/** Identifica o lançamento que uma movimentação vai gerar. */
export interface LedgerReference {
  transactionId: string;
  ledgerEntryId: string;
  at: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  now: Date;
  /** Obrigatório quando initialBalance > 0: a transação OPENING e seu lançamento. */
  opening?: { transactionId: string; ledgerEntryId: string };
}

export interface WalletOpening {
  wallet: Wallet;
  /** Lançamento CREDIT do saldo inicial (ausente quando o saldo inicial é zero). */
  openingEntry?: WalletLedgerEntry;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate Root da carteira.
 *
 * TODA mudança de saldo passa por `debit`/`credit`, que:
 *   1. validam moeda e saldo;
 *   2. calculam o novo saldo;
 *   3. incrementam `version`;
 *   4. devolvem o lançamento do ledger correspondente.
 * Assim saldo e ledger nunca divergem: não existe forma de mudar
 * o saldo sem gerar o lançamento (e vice-versa).
 *
 * Proteções contra concorrência ficam na infraestrutura (lock pessimista)
 * e no banco (CHECK balance >= 0, trigger de versão/ledger).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre uma carteira nova. `version` começa em 1.
   * Se houver saldo inicial, gera o lançamento CREDIT da transação OPENING
   * (persistido na mesma transação SQL pela camada de aplicação).
   */
  static open(props: OpenWalletProps): WalletOpening {
    if (props.initialBalance.isNegative()) {
      throw new ValidationError('INVALID_MONEY', 'Initial balance cannot be negative');
    }
    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );

    if (props.initialBalance.isZero()) {
      return { wallet };
    }
    if (!props.opening) {
      throw new InvariantViolationError('Opening a wallet with balance requires an OPENING transaction');
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.ledgerEntryId,
      walletId: wallet.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: props.initialBalance,
      walletVersion: 1,
      createdAt: props.now,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.rehydrate(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Débito: lança InsufficientFundsError se o saldo ficaria negativo. */
  debit(money: Money, ref: LedgerReference): WalletLedgerEntry {
    this.assertSameCurrency(money);
    this.assertPositive(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(this._balance, money);
    }
    return this.apply(LedgerDirection.Debit, money, ref);
  }

  credit(money: Money, ref: LedgerReference): WalletLedgerEntry {
    this.assertSameCurrency(money);
    this.assertPositive(money);
    return this.apply(LedgerDirection.Credit, money, ref);
  }

  toState(): WalletState {
    return {
      id: this.id,
      playerId: this.playerId,
      currency: this.currency,
      balance: this._balance.toJSON(),
      version: this._version,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }

  /** Único ponto onde o saldo muda: gera o lançamento e incrementa a versão juntos. */
  private apply(direction: LedgerDirection, money: Money, ref: LedgerReference): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Credit ? before.add(money) : before.subtract(money);
    const nextVersion = this._version + 1;

    // create() valida a aritmética e a não-negatividade antes de mudarmos qualquer estado.
    const entry = WalletLedgerEntry.create({
      id: ref.ledgerEntryId,
      walletId: this.id,
      transactionId: ref.transactionId,
      direction,
      money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: ref.at,
    });

    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = ref.at;
    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }

  private assertPositive(money: Money): void {
    if (!money.isPositive()) {
      throw new InvariantViolationError(`Wallet movements must be positive, got ${money}`);
    }
  }
}
