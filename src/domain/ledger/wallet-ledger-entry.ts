import { Money, type MoneyProps } from '../money/money';
import { InvariantViolationError } from '../shared/domain-error';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  /** Versão da wallet DEPOIS deste lançamento. Encadeia o extrato: 1, 2, 3... sem buracos. */
  walletVersion: number;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
  createdAt: Date;
}

/**
 * Uma linha do extrato (ledger). IMUTÁVEL por construção:
 * - todos os campos são `readonly`;
 * - não existe nenhum método que altere estado (sem setters, sem transições);
 * - o objeto é congelado com Object.freeze.
 *
 * No banco, um trigger impede UPDATE/DELETE nesta tabela (append-only).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Cria um lançamento NOVO e valida a aritmética: before ± money === after. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvariantViolationError('Ledger entry amount must be positive');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvariantViolationError('Ledger entry would produce a negative balance');
    }
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.walletVersion,
      props.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new InvariantViolationError(
        `Unbalanced ledger entry: ${props.balanceBefore} ${props.direction} ${props.money} != ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrói a partir do banco. Não revalida (o dado já foi validado na criação e pelo CHECK do banco). */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.rehydrate(state.money),
      Money.rehydrate(state.balanceBefore),
      Money.rehydrate(state.balanceAfter),
      state.walletVersion,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  /** Efeito com sinal no saldo: +money para crédito, -money para débito. Usado na reconciliação. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }

  toState(): LedgerEntryState {
    return {
      id: this.id,
      walletId: this.walletId,
      transactionId: this.transactionId,
      direction: this.direction,
      money: this.money.toJSON(),
      balanceBefore: this.balanceBefore.toJSON(),
      balanceAfter: this.balanceAfter.toJSON(),
      walletVersion: this.walletVersion,
      createdAt: this.createdAt,
    };
  }
}
