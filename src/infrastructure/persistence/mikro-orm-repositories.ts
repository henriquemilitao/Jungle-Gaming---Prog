import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { Money } from '../../domain/money/money';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import type { InboxMessage } from '../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import { WagerTransactionStatus, type WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { Metrics } from '../../application/observability';
import type {
  DuePendingReference,
  InboxRepository,
  LedgerPage,
  LedgerRepository,
  LedgerTotals,
  OutboxRepository,
  UnitOfWork,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports';
import { isLockNotAvailable } from './db-errors';
import {
  inboxRecordData,
  inboxToDomain,
  ledgerRecordData,
  ledgerToDomain,
  outboxRecordData,
  transactionRecordData,
  transactionToDomain,
  walletRecordData,
  walletToDomain,
} from './mappers';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/*
 * Repositórios MikroORM. Todos recebem o EntityManager DA TRANSAÇÃO corrente
 * (`em.transactional`), então tudo que escrevem entra no mesmo COMMIT.
 *
 * Inserções/alterações usam o Unit of Work do MikroORM (persist/assign) e são
 * enviadas ao banco no flush que acontece imediatamente antes do COMMIT.
 */

class MikroOrmWalletRepository implements WalletRepository {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: Metrics,
  ) {}

  async findById(id: string): Promise<Wallet | null> {
    const rec = await this.em.findOne(WalletRecord, { id });
    return rec ? walletToDomain(rec) : null;
  }

  /**
   * Lock PESSIMISTA só desta wallet (SELECT ... FOR UPDATE).
   *
   * Antes do lock bloqueante, uma sondagem NOWAIT dentro de um SAVEPOINT detecta se
   * outra transação já está segurando a wallet — isso alimenta a métrica de
   * "conflitos de lock" sem mudar o comportamento (em seguida esperamos a vez normalmente,
   * limitados pelo lock_timeout da transação).
   */
  async findByIdForUpdate(id: string): Promise<Wallet | null> {
    await this.em.execute('savepoint wallet_lock_probe');
    try {
      await this.em.execute('select 1 from wallet where id = ? for update nowait', [id]);
      await this.em.execute('release savepoint wallet_lock_probe');
    } catch (err) {
      if (!isLockNotAvailable(err)) throw err;
      await this.em.execute('rollback to savepoint wallet_lock_probe');
      this.metrics.lockConflict('contended');
    }
    const rec = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return rec ? walletToDomain(rec) : null;
  }

  async findByIdForShare(id: string): Promise<Wallet | null> {
    const rec = await this.em.findOne(WalletRecord, { id }, { lockMode: LockMode.PESSIMISTIC_READ, refresh: true });
    return rec ? walletToDomain(rec) : null;
  }

  async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
    const rec = await this.em.findOne(WalletRecord, { playerId, currency });
    return rec ? walletToDomain(rec) : null;
  }

  async insert(wallet: Wallet): Promise<void> {
    this.em.persist(this.em.create(WalletRecord, walletRecordData(wallet)));
  }

  async update(wallet: Wallet): Promise<void> {
    // Já está no Identity Map (carregada com lock); não faz nova query.
    const rec = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    this.em.assign(rec, walletRecordData(wallet));
  }
}

class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findById(id: string): Promise<WagerTransaction | null> {
    const rec = await this.em.findOne(WagerTransactionRecord, { id });
    return rec ? transactionToDomain(rec) : null;
  }

  async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
    const rec = await this.em.findOne(WagerTransactionRecord, { idempotencyKey }, { refresh: true });
    return rec ? transactionToDomain(rec) : null;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const rec = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId }, { refresh: true });
    return rec ? transactionToDomain(rec) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: ['REFUND', 'ROLLBACK'] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<DuePendingReference[]> {
    const rows = await this.em.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceAttemptAt: { $lte: now } },
      { fields: ['id', 'walletId'], orderBy: { nextReferenceAttemptAt: 'asc' }, limit },
    );
    return rows.map((r) => ({ id: r.id, walletId: r.walletId }));
  }

  async expediteDependents(providerId: string, externalTransactionId: string, now: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $gt: now },
      },
      { nextReferenceAttemptAt: now, updatedAt: now },
    );
  }

  async insert(tx: WagerTransaction): Promise<void> {
    this.em.persist(this.em.create(WagerTransactionRecord, transactionRecordData(tx, tx.createdAt)));
  }

  async update(tx: WagerTransaction): Promise<void> {
    const rec = await this.em.findOneOrFail(WagerTransactionRecord, { id: tx.id });
    this.em.assign(rec, transactionRecordData(tx, new Date()));
  }
}

class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    // Somente INSERT: o ledger é append-only (trigger no banco bloqueia UPDATE/DELETE).
    this.em.persist(this.em.create(LedgerEntryRecord, ledgerRecordData(entry)));
  }

  async listByWallet(walletId: string, afterVersion: number, limit: number): Promise<LedgerPage> {
    const rows = await this.em.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit: limit + 1 },
    );
    const hasMore = rows.length > limit;
    return { entries: rows.slice(0, limit).map(ledgerToDomain), hasMore };
  }

  async totals(walletId: string, currency: string): Promise<LedgerTotals> {
    // Soma feita em NUMERIC pelo próprio Postgres: exata, e sem trazer milhões de linhas para a memória.
    const [row] = await this.em.execute<{ total: string; entries: number }[]>(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as total,
              count(*)::int as entries
         from wallet_ledger_entry
        where wallet_id = ?`,
      [walletId],
    );
    return { sum: Money.rehydrate({ amount: row!.total, currency }), count: Number(row!.entries) };
  }
}

class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const rec = await this.em.findOne(InboxMessageRecord, { consumerName, messageId }, { refresh: true });
    return rec ? inboxToDomain(rec) : null;
  }

  async insert(message: InboxMessage): Promise<void> {
    // PK (consumer_name, message_id): uma entrega concorrente da mesma mensagem viola a
    // unicidade no COMMIT → a transação é refeita e encontra o registro (duplicate_message).
    this.em.persist(this.em.create(InboxMessageRecord, inboxRecordData(message)));
  }
}

class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async add(message: OutboxMessage): Promise<void> {
    this.em.persist(this.em.create(OutboxMessageRecord, outboxRecordData(message)));
  }
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;

  constructor(em: EntityManager, metrics: Metrics) {
    this.wallets = new MikroOrmWalletRepository(em, metrics);
    this.transactions = new MikroOrmWagerTransactionRepository(em);
    this.ledger = new MikroOrmLedgerRepository(em);
    this.inbox = new MikroOrmInboxRepository(em);
    this.outbox = new MikroOrmOutboxRepository(em);
  }
}
