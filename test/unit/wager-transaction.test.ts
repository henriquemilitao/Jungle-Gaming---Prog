import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { ValidationError } from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  InvalidTransactionStateError,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from '../../src/domain/wagering/wager-transaction';
import { brl, NOW, wager } from '../support/fixtures';

describe('WagerTransaction.create', () => {
  test('nasce em PENDING', () => {
    expect(wager(K.Bet, '10.00').status).toBe(S.Pending);
  });

  test('OPENING não pode ser submetido por provedor (é interno)', () => {
    expect(() => wager(K.Opening, '10.00')).toThrow(ValidationError);
  });

  test.each([K.Refund, K.Rollback])('%s exige referenceExternalTransactionId', (kind) => {
    try {
      wager(kind, '10.00');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ValidationError).code).toBe('REFERENCE_REQUIRED');
    }
  });

  test('BET não pode referenciar outra transação', () => {
    expect(() => wager(K.Bet, '10.00', { referenceExternalTransactionId: 'x' })).toThrow(ValidationError);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => wager(K.Bet, '0.00')).toThrow(ValidationError);
    expect(wager(K.Loss, '0.00').money.isZero()).toBe(true);
  });

  test('createOpening é o único caminho para OPENING', () => {
    const tx = WagerTransaction.createOpening({
      id: 't',
      providerId: 'internal',
      externalTransactionId: 'opening:w1',
      idempotencyKey: 'internal:opening:w1',
      payloadHash: 'h',
      walletId: 'w1',
      playerId: 'p1',
      roundId: 'opening',
      gameId: 'internal',
      money: brl('10.00'),
      correlationId: 'c',
      createdAt: NOW,
    });
    expect(tx.kind).toBe(K.Opening);
  });
});

describe('WagerTransaction — máquina de estados', () => {
  test('estados terminais não aceitam nenhuma transição', () => {
    const processed = wager(K.Bet, '10.00');
    processed.markProcessed(undefined, NOW, brl('90.00'));
    expect(processed.isTerminal()).toBe(true);
    expect(() => processed.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markProcessed(undefined, NOW, brl('1.00'))).toThrow(InvalidTransactionStateError);
    expect(() => processed.fail(FailureCode.ProcessingFailed)).toThrow(InvalidTransactionStateError);

    const rejected = wager(K.Bet, '10.00');
    rejected.reject(FailureCode.InsufficientFunds);
    expect(() => rejected.markProcessed(undefined, NOW, brl('1.00'))).toThrow(InvalidTransactionStateError);

    const failed = wager(K.Bet, '10.00');
    failed.fail(FailureCode.ProcessingFailed);
    expect(() => failed.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING → PENDING_REFERENCE → PROCESSED', () => {
    const tx = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(NOW, brl('0.00'));
    expect(tx.status).toBe(S.PendingReference);
    tx.scheduleReferenceRetry(NOW);
    expect(tx.referenceAttempts).toBe(1);
    tx.markProcessed('ref-id', NOW, brl('10.00'));
    expect(tx.status).toBe(S.Processed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  test('scheduleReferenceRetry só vale para PENDING_REFERENCE', () => {
    expect(() => wager(K.Bet, '1.00').scheduleReferenceRetry(NOW)).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction — consultas de domínio', () => {
  test('affectsBalance é false somente para LOSS', () => {
    expect(wager(K.Loss, '0.00').affectsBalance()).toBe(false);
    expect(wager(K.Bet, '1.00').affectsBalance()).toBe(true);
    expect(wager(K.Win, '1.00').affectsBalance()).toBe(true);
  });

  test('requiresReference é true para REFUND e ROLLBACK', () => {
    expect(wager(K.Refund, '1.00', { referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
    expect(wager(K.Rollback, '1.00', { referenceExternalTransactionId: 'x' }).requiresReference()).toBe(true);
    expect(wager(K.Win, '1.00').requiresReference()).toBe(false);
  });

  test('ledgerDirectionFor: ROLLBACK inverte a direção da referência', () => {
    const bet = wager(K.Bet, '1.00');
    const win = wager(K.Win, '1.00');
    const refund = wager(K.Refund, '1.00', { referenceExternalTransactionId: 'x' });
    const rollback = wager(K.Rollback, '1.00', { referenceExternalTransactionId: 'x' });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
  });

  test('matchesPayload compara o hash do payload', () => {
    const tx = wager(K.Bet, '1.00', { payloadHash: 'abc' });
    expect(tx.matchesPayload('abc')).toBe(true);
    expect(tx.matchesPayload('xyz')).toBe(false);
  });

  test('rehydrate reconstrói estado terminal sem revalidar', () => {
    const tx = wager(K.Bet, '1.00');
    tx.reject(FailureCode.InsufficientFunds, Money.zero('BRL'));
    const copy = WagerTransaction.rehydrate(tx.toState());
    expect(copy.status).toBe(S.Rejected);
    expect(copy.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});
