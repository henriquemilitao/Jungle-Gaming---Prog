import Decimal from 'decimal.js';
import { DomainError, ValidationError } from '../shared/domain-error';

/** DTO de dinheiro nos contratos (API, fila, eventos). Sempre string. */
export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217, ex.: "BRL"
}

/** Escala fixa: 2 casas decimais. */
export const MONEY_SCALE = 2;

/**
 * Formato aceito na ENTRADA (contratos): inteiro sem zeros à esquerda,
 * ponto e exatamente 2 casas. Limite de 15 dígitos inteiros cabe com folga em NUMERIC(19,2).
 *
 * Rejeita automaticamente: "" (vazio), "NaN", "Infinity", "1e3" (notação científica),
 * "10.555" (3 casas), "10.5" (escala diferente de 2), "-5.00" (negativo), " 5.00" (espaços).
 */
const CONTRACT_AMOUNT_PATTERN = /^(0|[1-9]\d{0,14})\.\d{2}$/;

/** Formato aceito ao REIDRATAR do banco: pode ser negativo (ex.: diferença da reconciliação). */
const STORED_AMOUNT_PATTERN = /^-?(0|[1-9]\d{0,16})\.\d{2}$/;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class InvalidMoneyError extends ValidationError {
  constructor(message: string) {
    super('INVALID_MONEY', message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Value Object de dinheiro.
 *
 * - IMUTÁVEL: toda operação devolve uma NOVA instância; `this` nunca muda.
 * - Usa `Decimal` (aritmética decimal exata) — nunca `number`, porque em
 *   ponto flutuante 0.1 + 0.2 = 0.30000000000000004.
 * - Construtor privado: a única forma de criar é pelas factories, que validam.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Factory para valores vindos de contratos externos (API/fila). Validação estrita. */
  static from(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);
    if (typeof props.amount !== 'string' || !CONTRACT_AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `Invalid amount "${String(props.amount)}": expected a non-negative decimal string with exactly ${MONEY_SCALE} decimal places (e.g. "25.00")`,
      );
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  /**
   * Reconstrução a partir da persistência (NUMERIC(19,2) chega do Postgres como string).
   * Aceita negativos porque valores internos (ex.: `difference` da reconciliação) podem sê-lo.
   */
  static rehydrate(props: MoneyProps): Money {
    Money.assertValidCurrency(props.currency);
    if (!STORED_AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`Corrupted stored amount "${props.amount}"`);
    }
    return new Money(new Decimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertValidCurrency(currency);
    return new Money(new Decimal(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  /** Valor como string com escala fixa de 2 casas. Ex.: "975.00". */
  get amount(): string {
    // Operações só somam/subtraem valores de 2 casas, então nunca há arredondamento real aqui.
    // toFixed apenas normaliza a representação ("-0.00" vira "0.00").
    const fixed = this.value.toFixed(MONEY_SCALE);
    return fixed === '-0.00' ? '0.00' : fixed;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertValidCurrency(currency: string): void {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected ISO-4217 code (e.g. "BRL")`);
    }
  }
}
