/*
 * PORTAS (interfaces) que a camada de aplicação precisa do mundo de fora.
 * A infraestrutura (MikroORM, SQS, prom-client, pino) implementa essas interfaces.
 *
 * Benefício: os use cases não importam nada de banco/fila — trocar o ORM ou a fila
 * não muda as regras, e o ponto de extensão fica explícito (seção 14: "boundaries, portas").
 */
import type { Money } from '../domain/money/money';
import type { WalletLedgerEntry } from '../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../domain/messaging/inbox-message';
import type { OutboxMessage } from '../domain/messaging/outbox-message';
import type { WagerTransaction } from '../domain/wagering/wager-transaction';
import type { Wallet } from '../domain/wallet/wallet';

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE: trava SÓ a linha desta wallet até o fim da transação SQL. */
  findByIdForUpdate(id: string): Promise<Wallet | null>;
  /** SELECT ... FOR SHARE: impede escritas concorrentes enquanto lê (reconciliação). */
  findByIdForShare(id: string): Promise<Wallet | null>;
  findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
  insert(wallet: Wallet): Promise<void>;
  update(wallet: Wallet): Promise<void>;
}

export interface DuePendingReference {
  id: string;
  walletId: string;
}

export interface WagerTransactionRepository {
  findById(id: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(key: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  /** Já existe REFUND/ROLLBACK PROCESSED revertendo esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]>;
  /** Antecipa a próxima tentativa das transações que esperam por (providerId, externalTransactionId). */
  expediteDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number>;
  insert(tx: WagerTransaction): Promise<void>;
  update(tx: WagerTransaction): Promise<void>;
}

export interface LedgerPage {
  entries: WalletLedgerEntry[];
  hasMore: boolean;
}

export interface LedgerTotals {
  /** Σ créditos − Σ débitos, calculado em NUMERIC pelo banco (exato). */
  sum: Money;
  count: number;
}

export interface LedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;
  /** Paginação por cursor: lançamentos com walletVersion > afterVersion, em ordem. */
  listByWallet(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage>;
  totals(walletId: string, currency: string): Promise<LedgerTotals>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  insert(message: InboxMessage): Promise<void>;
}

export interface OutboxRepository {
  add(message: OutboxMessage): Promise<void>;
}

/** Repositórios ligados a UMA transação SQL. */
export interface UnitOfWork {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Executa `work` dentro de UMA transação SQL (BEGIN ... COMMIT).
 * Tudo que for escrito via `uow` é confirmado junto, ou nada é.
 * Reexecuta `work` (do zero) em conflitos transitórios: violação de unicidade
 * por corrida, deadlock.
 */
export interface TransactionRunner {
  run<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;
}

export interface IdGenerator {
  /** UUID v7 (ordenável por tempo). */
  next(): string;
}

export interface Clock {
  now(): Date;
}

export const TOKENS = {
  TransactionRunner: Symbol('TransactionRunner'),
  IdGenerator: Symbol('IdGenerator'),
  Clock: Symbol('Clock'),
  Metrics: Symbol('Metrics'),
  Logger: Symbol('Logger'),
} as const;
