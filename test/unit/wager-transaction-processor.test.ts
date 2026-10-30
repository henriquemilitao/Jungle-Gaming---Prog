import { describe, expect, test } from 'bun:test';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { ExponentialBackoff } from '../../src/domain/shared/exponential-backoff';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
  type WagerTransaction,
} from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionProcessor, type ReferenceLookup } from '../../src/domain/wagering/wager-transaction-processor';
import type { Wallet } from '../../src/domain/wallet/wallet';
import { id, NOW, openWallet, wager } from '../support/fixtures';

const processor = new WagerTransactionProcessor();
const ctx = () => ({
  now: NOW,
  ledgerEntryId: id('entry'),
  referenceBackoff: new ExponentialBackoff(1_000, 60_000),
  referenceMaxAttempts: 3,
});
const noRef: ReferenceLookup = { reference: undefined, alreadyReversed: false };
const refTo = (reference: WagerTransaction | null, alreadyReversed = false): ReferenceLookup => ({
  reference,
  alreadyReversed,
});

/** Processa uma BET e devolve a transação já PROCESSED, para servir de referência. */
function placeBet(wallet: Wallet, amount: string, ext = id('bet')): WagerTransaction {
  const bet = wager(K.Bet, amount, { externalTransactionId: ext });
  processor.process(bet, wallet, noRef, ctx());
  return bet;
}

describe('BET', () => {
  test('debita, gera 1 lançamento DEBIT e fica PROCESSED com o saldo resultante', () => {
    const wallet = openWallet('100.00');
    const bet = wager(K.Bet, '25.00');
    const outcome = processor.process(bet, wallet, noRef, ctx());
    expect(outcome.type).toBe('processed');
    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(bet.status).toBe(S.Processed);
    expect(bet.resultingBalance?.amount).toBe('75.00');
    expect(wallet.balance.amount).toBe('75.00');
  });

  test('saldo insuficiente → REJECTED/INSUFFICIENT_FUNDS, sem lançamento e sem mudar saldo/version', () => {
    const wallet = openWallet('100.00');
    const bet = wager(K.Bet, '100.01');
    const outcome = processor.process(bet, wallet, noRef, ctx());
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(S.Rejected);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('cenário da seção 8 (sequencial): 100 − 80 − 80 → uma PROCESSED, outra REJECTED, saldo 20', () => {
    const wallet = openWallet('100.00');
    const a = wager(K.Bet, '80.00');
    const b = wager(K.Bet, '80.00');
    processor.process(a, wallet, noRef, ctx());
    processor.process(b, wallet, noRef, ctx());
    expect([a.status, b.status]).toEqual([S.Processed, S.Rejected]);
    expect(b.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.amount).toBe('20.00');
  });

  test('moeda diferente da wallet → REJECTED/CURRENCY_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = wager(K.Bet, '10.00', { currency: 'USD' });
    expect(processor.process(bet, wallet, noRef, ctx())).toEqual({ type: 'rejected', code: FailureCode.CurrencyMismatch });
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('wallet de outro player → REJECTED/PLAYER_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = wager(K.Bet, '10.00', { playerId: 'other-player' });
    expect(processor.process(bet, wallet, noRef, ctx())).toEqual({ type: 'rejected', code: FailureCode.PlayerMismatch });
  });
});

describe('WIN', () => {
  test('credita e gera 1 lançamento CREDIT', () => {
    const wallet = openWallet('100.00');
    const win = wager(K.Win, '50.00');
    const outcome = processor.process(win, wallet, noRef, ctx());
    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('150.00');
  });

  test('pode referenciar a BET da mesma rodada', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '10.00', 'bet-1');
    const win = wager(K.Win, '30.00', { referenceExternalTransactionId: 'bet-1' });
    processor.process(win, wallet, refTo(bet), ctx());
    expect(win.status).toBe(S.Processed);
    expect(win.referenceTransactionId).toBe(bet.id);
  });

  test('referência de outra rodada → REJECTED/REFERENCE_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '10.00', 'bet-1');
    const win = wager(K.Win, '30.00', { referenceExternalTransactionId: 'bet-1', roundId: 'other-round' });
    expect(processor.process(win, wallet, refTo(bet), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceMismatch,
    });
  });
});

describe('LOSS', () => {
  test('PROCESSED sem lançamento, sem mudar saldo nem version', () => {
    const wallet = openWallet('100.00');
    const loss = wager(K.Loss, '0.00');
    const outcome = processor.process(loss, wallet, noRef, ctx());
    expect(outcome).toEqual({ type: 'processed' });
    expect(loss.status).toBe(S.Processed);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });
});

describe('REFUND', () => {
  test('reverte uma BET PROCESSED com CREDIT do mesmo valor', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '40.00', 'bet-1');
    const refund = wager(K.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    const outcome = processor.process(refund, wallet, refTo(bet), ctx());
    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
    expect(refund.referenceTransactionId).toBe(bet.id);
  });

  test('só referencia BET', () => {
    const wallet = openWallet('100.00');
    const win = wager(K.Win, '10.00', { externalTransactionId: 'win-1' });
    processor.process(win, wallet, noRef, ctx());
    const refund = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'win-1' });
    expect(processor.process(refund, wallet, refTo(win), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.InvalidReferenceKind,
    });
  });

  test('valor diferente da referência → REVERSAL_AMOUNT_MISMATCH (reversão parcial fora de escopo)', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '40.00', 'bet-1');
    const refund = wager(K.Refund, '20.00', { referenceExternalTransactionId: 'bet-1' });
    expect(processor.process(refund, wallet, refTo(bet), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.ReversalAmountMismatch,
    });
  });

  test('uma única vez: referência já revertida → ALREADY_REVERSED', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '40.00', 'bet-1');
    const refund = wager(K.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    expect(processor.process(refund, wallet, refTo(bet, true), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.AlreadyReversed,
    });
    expect(wallet.balance.amount).toBe('60.00');
  });

  test('referência REJECTED → REFERENCE_NOT_PROCESSED', () => {
    const wallet = openWallet('10.00');
    const bet = placeBet(wallet, '40.00', 'bet-1'); // rejeitada por saldo
    expect(bet.status).toBe(S.Rejected);
    const refund = wager(K.Refund, '40.00', { referenceExternalTransactionId: 'bet-1' });
    expect(processor.process(refund, wallet, refTo(bet), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.ReferenceNotProcessed,
    });
  });

  test('referência de outra wallet/player → REFERENCE_MISMATCH', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '40.00', 'bet-1');
    const refund = wager(K.Refund, '40.00', { referenceExternalTransactionId: 'bet-1', walletId: 'wallet-1', playerId: 'someone-else' });
    // playerId diferente da wallet é pego antes, como PLAYER_MISMATCH
    expect(processor.process(refund, wallet, refTo(bet), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.PlayerMismatch,
    });
  });
});

describe('ROLLBACK', () => {
  test('ROLLBACK de BET → CREDIT (devolve)', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '30.00', 'bet-1');
    const rb = wager(K.Rollback, '30.00', { referenceExternalTransactionId: 'bet-1' });
    const outcome = processor.process(rb, wallet, refTo(bet), ctx());
    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('ROLLBACK de WIN → DEBIT (retira o prêmio)', () => {
    const wallet = openWallet('100.00');
    const win = wager(K.Win, '50.00', { externalTransactionId: 'win-1' });
    processor.process(win, wallet, noRef, ctx());
    const rb = wager(K.Rollback, '50.00', { referenceExternalTransactionId: 'win-1' });
    const outcome = processor.process(rb, wallet, refTo(win), ctx());
    expect(outcome.type === 'processed' && outcome.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('ROLLBACK de REFUND → DEBIT', () => {
    const wallet = openWallet('100.00');
    const bet = placeBet(wallet, '30.00', 'bet-1');
    const refund = wager(K.Refund, '30.00', { externalTransactionId: 'refund-1', referenceExternalTransactionId: 'bet-1' });
    processor.process(refund, wallet, refTo(bet), ctx());
    const rb = wager(K.Rollback, '30.00', { referenceExternalTransactionId: 'refund-1' });
    processor.process(rb, wallet, refTo(refund), ctx());
    expect(rb.status).toBe(S.Processed);
    expect(wallet.balance.amount).toBe('70.00');
  });

  test('ROLLBACK de LOSS é inválido', () => {
    const wallet = openWallet('100.00');
    const loss = wager(K.Loss, '0.00', { externalTransactionId: 'loss-1' });
    processor.process(loss, wallet, noRef, ctx());
    const rb = wager(K.Rollback, '1.00', { referenceExternalTransactionId: 'loss-1' });
    expect(processor.process(rb, wallet, refTo(loss), ctx())).toEqual({
      type: 'rejected',
      code: FailureCode.InvalidReferenceKind,
    });
  });

  test('reversão que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (código distinto da aposta sem saldo)', () => {
    const wallet = openWallet('20.00');
    const win = wager(K.Win, '50.00', { externalTransactionId: 'win-1' });
    processor.process(win, wallet, noRef, ctx()); // 70
    processor.process(wager(K.Bet, '60.00'), wallet, noRef, ctx()); // 10
    const rb = wager(K.Rollback, '50.00', { referenceExternalTransactionId: 'win-1' });
    const outcome = processor.process(rb, wallet, refTo(win), ctx());
    expect(outcome).toEqual({ type: 'rejected', code: FailureCode.ReversalInsufficientFunds });
    expect(FailureCode.ReversalInsufficientFunds).not.toBe(FailureCode.InsufficientFunds);
    expect(wallet.balance.amount).toBe('10.00');
    expect(rb.status).toBe(S.Rejected); // permanece auditável
  });
});

describe('Referência fora de ordem (PENDING_REFERENCE)', () => {
  test('referência ausente → PENDING_REFERENCE com próxima tentativa agendada, sem mexer no saldo', () => {
    const wallet = openWallet('100.00');
    const refund = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-ainda-nao-chegou' });
    expect(processor.process(refund, wallet, refTo(null), ctx())).toEqual({ type: 'pending_reference' });
    expect(refund.status).toBe(S.PendingReference);
    expect(refund.nextReferenceAttemptAt!.getTime()).toBe(NOW.getTime() + 1_000);
    expect(wallet.version).toBe(1);
  });

  test('referência chega depois → reprocessamento aplica normalmente', () => {
    const wallet = openWallet('100.00');
    const refund = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    processor.process(refund, wallet, refTo(null), ctx());
    const bet = placeBet(wallet, '10.00', 'bet-1'); // 90
    processor.process(refund, wallet, refTo(bet), ctx()); // 100
    expect(refund.status).toBe(S.Processed);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('backoff exponencial e REJECTED/REFERENCE_NOT_FOUND ao esgotar o limite', () => {
    const wallet = openWallet('100.00');
    const refund = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'nunca-chega' });
    processor.process(refund, wallet, refTo(null), ctx()); // entra em pending (+1s)
    processor.process(refund, wallet, refTo(null), ctx()); // tentativa 1 (+2s)
    expect(refund.nextReferenceAttemptAt!.getTime()).toBe(NOW.getTime() + 2_000);
    processor.process(refund, wallet, refTo(null), ctx()); // tentativa 2
    const last = processor.process(refund, wallet, refTo(null), ctx()); // tentativa 3 = limite
    expect(last).toEqual({ type: 'rejected', code: FailureCode.ReferenceNotFound });
    expect(refund.status).toBe(S.Rejected);
  });
});
