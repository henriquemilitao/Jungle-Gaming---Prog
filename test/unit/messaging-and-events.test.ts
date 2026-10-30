import { describe, expect, test } from 'bun:test';
import { canonicalJson, computePayloadHash } from '../../src/application/idempotency/payload-hash';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../src/domain/events/wagering-events';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { ExponentialBackoff } from '../../src/domain/shared/exponential-backoff';
import { InvariantViolationError } from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { WagerTransactionKind as K } from '../../src/domain/wagering/wager-transaction';
import { brl, id, NOW, openWallet, wager } from '../support/fixtures';

const eventCtx = { newId: () => id('evt'), correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW };

const basePayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'p1',
  walletId: 'w1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};

describe('payloadHash — idempotency key com payload divergente', () => {
  test('mesmo conteúdo em ordem de chaves diferente → mesmo hash', () => {
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-987',
      walletId: 'w1',
      playerId: 'p1',
      externalTransactionId: 'transaction-123',
      providerId: 'provider-a',
    };
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(basePayload));
  });

  test('qualquer campo de negócio diferente → hash diferente (conflito, não replay)', () => {
    const base = computePayloadHash(basePayload);
    expect(computePayloadHash({ ...basePayload, money: { amount: '25.01', currency: 'BRL' } })).not.toBe(base);
    expect(computePayloadHash({ ...basePayload, kind: 'WIN' })).not.toBe(base);
    expect(computePayloadHash({ ...basePayload, roundId: 'round-988' })).not.toBe(base);
    expect(computePayloadHash({ ...basePayload, referenceExternalTransactionId: 'x' })).not.toBe(base);
  });

  test('metadados de transporte não entram no hash', () => {
    const withTransport = { ...basePayload, idempotencyKey: 'provider-a:transaction-123', messageId: 'msg-1' };
    expect(computePayloadHash(withTransport)).toBe(computePayloadHash(basePayload));
  });

  test('é SHA-256 hex de 64 caracteres sobre o JSON canônico', () => {
    expect(computePayloadHash(basePayload)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe('{"a":{"d":2},"b":1}');
  });
});

describe('InboxMessage', () => {
  test('receive → markProcessed uma única vez', () => {
    const msg = InboxMessage.receive({ messageId: 'm1', consumerName: 'c', payloadHash: 'h', receivedAt: NOW });
    expect(msg.isProcessed()).toBe(false);
    msg.markProcessed(NOW);
    expect(msg.isProcessed()).toBe(true);
    expect(() => msg.markProcessed(NOW)).toThrow(InvariantViolationError);
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('10.00'), { transactionId: 't1', ledgerEntryId: 'e1', at: NOW });
    return WalletBalanceChanged.from(wallet, entry, eventCtx);
  };

  test('enqueue: id = eventId, pendente e elegível imediatamente', () => {
    const ev = event();
    const msg = OutboxMessage.enqueue(ev);
    expect(msg.id).toBe(ev.eventId);
    expect(msg.eventType).toBe('WalletBalanceChanged');
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(NOW)).toBe(true);
  });

  test('scheduleRetry aplica backoff exponencial', () => {
    const msg = OutboxMessage.enqueue(event());
    const backoff = new ExponentialBackoff(1_000, 10_000);
    msg.scheduleRetry(NOW, backoff);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt!.getTime() - NOW.getTime()).toBe(1_000);
    expect(msg.isDue(NOW)).toBe(false);
    msg.scheduleRetry(NOW, backoff);
    expect(msg.nextAttemptAt!.getTime() - NOW.getTime()).toBe(2_000);
    for (let i = 0; i < 10; i++) msg.scheduleRetry(NOW, backoff);
    expect(msg.nextAttemptAt!.getTime() - NOW.getTime()).toBe(10_000); // teto
  });

  test('markPublished é definitivo', () => {
    const msg = OutboxMessage.enqueue(event());
    msg.markPublished(NOW);
    expect(msg.isPending()).toBe(false);
    expect(() => msg.markPublished(NOW)).toThrow(InvariantViolationError);
  });
});

describe('IntegrationEvent — envelope', () => {
  test('WalletBalanceChanged carrega MoneyProps (string), eventType e version no tipo', () => {
    const wallet = openWallet('100.00');
    const entry = wallet.debit(brl('25.00'), { transactionId: 't1', ledgerEntryId: 'e1', at: NOW });
    const json = WalletBalanceChanged.from(wallet, entry, eventCtx).toJSON();
    expect(json.eventType).toBe('WalletBalanceChanged');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(wallet.id);
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('msg-1');
    expect(json.occurredAt).toBe(NOW.toISOString());
    expect(json.data).toEqual({
      walletId: wallet.id,
      transactionId: 't1',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
    // payload é JSON puro e estável
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('cada evento exige o status correspondente da transação', () => {
    const tx = wager(K.Bet, '10.00');
    expect(() => WagerTransactionProcessed.from(tx, eventCtx)).toThrow(InvariantViolationError);
    tx.reject(FailureCode.InsufficientFunds, brl('0.00'));
    const rejected = WagerTransactionRejected.from(tx, eventCtx).toJSON();
    expect(rejected.eventType).toBe('WagerTransactionRejected');
    expect(rejected.data.failureCode).toBe(FailureCode.InsufficientFunds);

    const pending = wager(K.Refund, '10.00', { referenceExternalTransactionId: 'bet-x' });
    pending.markPendingReference(NOW, brl('0.00'));
    expect(WagerTransactionPendingReference.from(pending, eventCtx).toJSON().data.referenceExternalTransactionId).toBe(
      'bet-x',
    );
  });
});
