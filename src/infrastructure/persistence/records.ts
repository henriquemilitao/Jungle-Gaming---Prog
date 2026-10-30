import { EntitySchema } from '@mikro-orm/core';

/*
 * Registros de PERSISTÊNCIA (o formato das linhas no banco), separados das
 * classes de domínio. O domínio não conhece o ORM: os repositórios convertem
 * registro ⇄ domínio (rehydrate / toState).
 *
 * Mapeamos com EntitySchema (sem decorators) para manter o mapeamento fora do domínio.
 * Valores monetários: `decimal` → o MikroORM devolve STRING (ex.: "975.00"),
 * nunca number. Valor e moeda em colunas separadas: NUMERIC(19,2) + CHAR(3).
 *
 * O schema real (constraints, triggers, índices) está na migration — aqui só o mapeamento.
 */

const money = { type: 'decimal', precision: 19, scale: 2 } as const;
const timestamp = { type: 'datetime', columnType: 'timestamptz' } as const;

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallet',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceAmount: { ...money },
    version: { type: 'integer' },
    createdAt: { ...timestamp },
    updatedAt: { ...timestamp },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultingBalanceAmount?: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt?: Date | null;
  correlationId!: string;
  createdAt!: Date;
  processedAt?: Date | null;
  updatedAt!: Date;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transaction',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    resultingBalanceAmount: { ...money, nullable: true },
    referenceAttempts: { type: 'integer' },
    nextReferenceAttemptAt: { ...timestamp, nullable: true },
    correlationId: { type: 'string' },
    createdAt: { ...timestamp },
    processedAt: { ...timestamp, nullable: true },
    updatedAt: { ...timestamp },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entry',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: { ...money },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { ...money },
    balanceAfter: { ...money },
    walletVersion: { type: 'integer' },
    createdAt: { ...timestamp },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_message',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: { ...timestamp },
    processedAt: { ...timestamp, nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
  lastError?: string | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_message',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'uuid' },
    eventType: { type: 'string' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { ...timestamp },
    attempts: { type: 'integer' },
    nextAttemptAt: { ...timestamp, nullable: true },
    publishedAt: { ...timestamp, nullable: true },
    lastError: { type: 'string', nullable: true },
  },
});

export const ALL_SCHEMAS = [
  WalletSchema,
  WagerTransactionSchema,
  LedgerEntrySchema,
  InboxMessageSchema,
  OutboxMessageSchema,
];
