import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from '../../src/domain/money/money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

describe('Money — validação de entrada', () => {
  test.each([
    ['', 'string vazia'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    ['1e3', 'notação científica'],
    ['1E3', 'notação científica maiúscula'],
    ['10.555', 'mais de 2 casas'],
    ['10.5', 'escala diferente de 2'],
    ['10', 'sem casas decimais'],
    ['-5.00', 'negativo em contrato de entrada'],
    [' 5.00', 'espaço'],
    ['05.00', 'zero à esquerda'],
    ['abc', 'texto'],
    ['0x10', 'hexadecimal'],
    ['1,00', 'vírgula'],
  ])('rejeita "%s" (%s)', (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test('rejeita amount que não é string (number é proibido)', () => {
    expect(() => Money.from({ amount: 25 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', ''])('rejeita moeda inválida "%s"', (currency) => {
    expect(() => Money.from({ amount: '1.00', currency })).toThrow(InvalidMoneyError);
  });

  test('aceita valores válidos com escala fixa de 2 casas', () => {
    expect(brl('0.00').amount).toBe('0.00');
    expect(brl('25.00').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(brl('999999999999999.99').amount).toBe('999999999999999.99');
  });
});

describe('Money — aritmética exata e imutabilidade', () => {
  test('0.10 + 0.20 é exatamente 0.30 (sem erro de ponto flutuante)', () => {
    expect(brl('0.10').add(brl('0.20')).amount).toBe('0.30');
  });

  test('operações retornam NOVA instância e não alteram a original', () => {
    const a = brl('100.00');
    const b = a.subtract(brl('80.00'));
    expect(a.amount).toBe('100.00');
    expect(b.amount).toBe('20.00');
    expect(b).not.toBe(a);
  });

  test('instância é congelada (imutável em runtime)', () => {
    const a = brl('1.00');
    expect(Object.isFrozen(a)).toBe(true);
  });

  test('sem arredondamento: somas sucessivas de centavos são exatas', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
    expect(total.amount).toBe('10.00');
  });

  test('negate, isNegative, isPositive, isZero', () => {
    const neg = brl('5.00').negate();
    expect(neg.amount).toBe('-5.00');
    expect(neg.isNegative()).toBe(true);
    expect(brl('5.00').isPositive()).toBe(true);
    expect(brl('0.00').isZero()).toBe(true);
    expect(brl('0.00').negate().amount).toBe('0.00');
  });

  test('comparações', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
    expect(brl('80.00').equals(brl('80.00'))).toBe(true);
    expect(brl('80.00').equals(Money.from({ amount: '80.00', currency: 'USD' }))).toBe(false);
  });

  test('toString', () => {
    expect(brl('975.00').toString()).toBe('975.00 BRL');
  });
});

describe('Money — conflito de moeda', () => {
  const usd = Money.from({ amount: '10.00', currency: 'USD' });

  test.each([
    ['add', () => brl('10.00').add(usd)],
    ['subtract', () => brl('10.00').subtract(usd)],
    ['isLessThan', () => brl('10.00').isLessThan(usd)],
  ])('%s entre moedas diferentes lança erro de domínio', (_name, op) => {
    expect(op).toThrow(CurrencyMismatchError);
  });

  test('o erro carrega um code estável', () => {
    try {
      brl('1.00').add(usd);
    } catch (e) {
      expect((e as CurrencyMismatchError).code).toBe('CURRENCY_MISMATCH');
    }
  });
});

describe('Money — reidratação do banco', () => {
  test('aceita negativo vindo da persistência (ex.: difference da reconciliação)', () => {
    expect(Money.rehydrate({ amount: '-3.50', currency: 'BRL' }).amount).toBe('-3.50');
  });

  test('rejeita valor corrompido', () => {
    expect(() => Money.rehydrate({ amount: '3.5', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });
});
