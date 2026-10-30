import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../../src/domain/money/money';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { InsufficientFundsError, Wallet } from '../../src/domain/wallet/wallet';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { brl, NOW, openWallet, PLAYER } from '../support/fixtures';

const ref = (n: number) => ({ transactionId: `tx-${n}`, ledgerEntryId: `entry-${n}`, at: NOW });

describe('Wallet.open', () => {
  test('version começa em 1 e saldo inicial gera lançamento CREDIT de abertura', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: PLAYER,
      initialBalance: brl('1000.00'),
      now: NOW,
      opening: { transactionId: 'opening-tx', ledgerEntryId: 'entry-0' },
    });
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry?.walletVersion).toBe(1);
  });

  test('saldo inicial zero não gera lançamento', () => {
    const { wallet, openingEntry } = Wallet.open({ id: 'w1', playerId: PLAYER, initialBalance: brl('0.00'), now: NOW });
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('saldo inicial positivo sem OPENING é erro de programação', () => {
    expect(() => Wallet.open({ id: 'w1', playerId: PLAYER, initialBalance: brl('1.00'), now: NOW })).toThrow(
      InvariantViolationError,
    );
  });
});

describe('Wallet — invariantes de saldo, ledger e versão', () => {
  test('débito gera lançamento DEBIT consistente e incrementa version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('25.00'), ref(1));
    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('75.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.isBalanced()).toBe(true);
  });

  test('crédito gera lançamento CREDIT e incrementa version', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.credit(brl('50.00'), ref(1));
    expect(wallet.balance.amount).toBe('150.00');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
  });

  test('saldo nunca negativo: débito maior que o saldo lança erro e NÃO altera nada', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.debit(brl('100.01'), ref(1))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('débito do saldo exato zera a carteira', () => {
    const wallet = openWallet('100.00');
    wallet.debit(brl('100.00'), ref(1));
    expect(wallet.balance.amount).toBe('0.00');
  });

  test('moeda da operação deve ser a da wallet', () => {
    const wallet = openWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit(usd, ref(1))).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, ref(1))).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('movimentos de valor zero não são permitidos (não mudariam o saldo, mas mudariam a version)', () => {
    const wallet = openWallet('100.00');
    expect(() => wallet.credit(brl('0.00'), ref(1))).toThrow(InvariantViolationError);
  });

  test('saldo reconstruído pelo ledger == saldo da wallet', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w1',
      playerId: PLAYER,
      initialBalance: brl('100.00'),
      now: NOW,
      opening: { transactionId: 'o', ledgerEntryId: 'e0' },
    });
    const entries: WalletLedgerEntry[] = [openingEntry!];
    entries.push(wallet.debit(brl('30.00'), ref(1)));
    entries.push(wallet.credit(brl('12.34'), ref(2)));
    entries.push(wallet.debit(brl('0.01'), ref(3)));
    const rebuilt = entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero('BRL'));
    expect(rebuilt.equals(wallet.balance)).toBe(true);
    expect(entries.map((e) => e.walletVersion)).toEqual([1, 2, 3, 4]);
  });

  test('rehydrate reconstrói o estado sem revalidar', () => {
    const wallet = Wallet.rehydrate({
      id: 'w1',
      playerId: PLAYER,
      currency: 'BRL',
      balance: { amount: '20.00', currency: 'BRL' },
      version: 7,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(wallet.version).toBe(7);
    expect(wallet.balance.amount).toBe('20.00');
  });
});

describe('WalletLedgerEntry — imutável e balanceado', () => {
  test('create rejeita lançamento com aritmética errada', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'e1',
        walletId: 'w1',
        transactionId: 't1',
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('95.00'),
        walletVersion: 2,
        createdAt: NOW,
      }),
    ).toThrow(InvariantViolationError);
  });

  test('objeto congelado: não é possível alterar campos', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('10.00'), ref(1));
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletId: string }).walletId = 'hack';
    }).toThrow();
  });
});
