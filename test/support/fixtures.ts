import { Money } from '../../src/domain/money/money';
import { Wallet } from '../../src/domain/wallet/wallet';
import { WagerTransaction, WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';

let seq = 0;
export const id = (prefix = 'id') => `${prefix}-${++seq}`;

export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export const PLAYER = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const NOW = new Date('2026-10-30T12:00:00.000Z');

export function openWallet(balance = '100.00', currency = 'BRL'): Wallet {
  return Wallet.open({
    id: 'wallet-1',
    playerId: PLAYER,
    initialBalance: Money.from({ amount: balance, currency }),
    now: NOW,
    opening: { transactionId: id('opening'), ledgerEntryId: id('entry') },
  }).wallet;
}

export function wager(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<{
    externalTransactionId: string;
    referenceExternalTransactionId: string;
    roundId: string;
    playerId: string;
    walletId: string;
    providerId: string;
    currency: string;
    payloadHash: string;
  }> = {},
): WagerTransaction {
  const externalTransactionId = overrides.externalTransactionId ?? id('ext');
  return WagerTransaction.create({
    id: id('tx'),
    providerId: overrides.providerId ?? 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    payloadHash: overrides.payloadHash ?? 'hash',
    walletId: overrides.walletId ?? 'wallet-1',
    playerId: overrides.playerId ?? PLAYER,
    roundId: overrides.roundId ?? 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: Money.from({ amount, currency: overrides.currency ?? 'BRL' }),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    correlationId: 'corr-1',
    createdAt: NOW,
  });
}
