import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import type {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/*
 * Conversão registro (banco) ⇄ domínio.
 * Do banco para o domínio SEMPRE via `rehydrate` (não revalida transições).
 * Do domínio para o banco via `toState()`.
 */

export const walletToDomain = (r: WalletRecord): Wallet =>
  Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: { amount: r.balanceAmount, currency: r.currency },
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });

export const walletRecordData = (w: Wallet): WalletRecord => {
  const s = w.toState();
  return {
    id: s.id,
    playerId: s.playerId,
    currency: s.currency,
    balanceAmount: s.balance.amount,
    version: s.version,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
};

export const transactionToDomain = (r: WagerTransactionRecord): WagerTransaction =>
  WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: { amount: r.amount, currency: r.currency },
    referenceExternalTransactionId: r.referenceExternalTransactionId ?? undefined,
    correlationId: r.correlationId,
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: r.referenceTransactionId ?? undefined,
    failureCode: (r.failureCode as FailureCode | null) ?? undefined,
    processedAt: r.processedAt ?? undefined,
    resultingBalance:
      r.resultingBalanceAmount != null ? { amount: r.resultingBalanceAmount, currency: r.currency } : undefined,
    referenceAttempts: r.referenceAttempts,
    nextReferenceAttemptAt: r.nextReferenceAttemptAt ?? undefined,
  });

export const transactionRecordData = (tx: WagerTransaction, updatedAt: Date): WagerTransactionRecord => {
  const s = tx.toState();
  return {
    id: s.id,
    providerId: s.providerId,
    externalTransactionId: s.externalTransactionId,
    idempotencyKey: s.idempotencyKey,
    payloadHash: s.payloadHash,
    walletId: s.walletId,
    playerId: s.playerId,
    roundId: s.roundId,
    gameId: s.gameId,
    kind: s.kind,
    amount: s.money.amount,
    currency: s.money.currency,
    referenceExternalTransactionId: s.referenceExternalTransactionId ?? null,
    referenceTransactionId: s.referenceTransactionId ?? null,
    status: s.status,
    failureCode: s.failureCode ?? null,
    resultingBalanceAmount: s.resultingBalance?.amount ?? null,
    referenceAttempts: s.referenceAttempts,
    nextReferenceAttemptAt: s.nextReferenceAttemptAt ?? null,
    correlationId: s.correlationId,
    createdAt: s.createdAt,
    processedAt: s.processedAt ?? null,
    updatedAt,
  };
};

export const ledgerToDomain = (r: LedgerEntryRecord): WalletLedgerEntry =>
  WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    direction: r.direction as LedgerDirection,
    money: { amount: r.amount, currency: r.currency },
    balanceBefore: { amount: r.balanceBefore, currency: r.currency },
    balanceAfter: { amount: r.balanceAfter, currency: r.currency },
    walletVersion: r.walletVersion,
    createdAt: r.createdAt,
  });

export const ledgerRecordData = (e: WalletLedgerEntry): LedgerEntryRecord => ({
  id: e.id,
  walletId: e.walletId,
  transactionId: e.transactionId,
  direction: e.direction,
  amount: e.money.amount,
  currency: e.money.currency,
  balanceBefore: e.balanceBefore.amount,
  balanceAfter: e.balanceAfter.amount,
  walletVersion: e.walletVersion,
  createdAt: e.createdAt,
});

export const inboxToDomain = (r: InboxMessageRecord): InboxMessage =>
  InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: r.processedAt ?? undefined,
  });

export const inboxRecordData = (m: InboxMessage): InboxMessageRecord => {
  const s = m.toState();
  return {
    consumerName: s.consumerName,
    messageId: s.messageId,
    payloadHash: s.payloadHash,
    receivedAt: s.receivedAt,
    processedAt: s.processedAt ?? null,
  };
};

export const outboxToDomain = (r: OutboxMessageRecord): OutboxMessage =>
  OutboxMessage.rehydrate({
    id: r.id,
    aggregateId: r.aggregateId,
    eventType: r.eventType,
    payload: r.payload,
    occurredAt: r.occurredAt,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt ?? undefined,
    publishedAt: r.publishedAt ?? undefined,
  });

export const outboxRecordData = (m: OutboxMessage): OutboxMessageRecord => {
  const s = m.toState();
  return {
    id: s.id,
    aggregateId: s.aggregateId,
    eventType: s.eventType,
    payload: s.payload as Record<string, unknown>,
    occurredAt: s.occurredAt,
    attempts: s.attempts,
    nextAttemptAt: s.nextAttemptAt ?? null,
    publishedAt: s.publishedAt ?? null,
    lastError: null,
  };
};
