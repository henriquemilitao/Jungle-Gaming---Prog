import { Money, type MoneyProps } from '../../domain/money/money';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event';
import type { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { ExponentialBackoff } from '../../domain/shared/exponential-backoff';
import { WagerTransaction, type WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import {
  WagerTransactionProcessor,
  type ProcessOutcome,
  type ReferenceLookup,
} from '../../domain/wagering/wager-transaction-processor';
import type { Wallet } from '../../domain/wallet/wallet';
import { ExternalTransactionConflictError, IdempotencyConflictError, InboxPayloadMismatchError } from '../errors';
import { computePayloadHash, type WagerBusinessPayload } from '../idempotency/payload-hash';
import type { AppLogger, Metrics } from '../observability';
import type { Clock, IdGenerator, TransactionRunner, UnitOfWork } from '../ports';
import { resultFrom, walletNotFoundResult, type WagerOutcome } from './wager-result';

export interface WageringSettings {
  referenceBackoff: ExponentialBackoff;
  referenceMaxAttempts: number;
}

/** Os mesmos campos chegam pelo body HTTP ou pelo `data` da mensagem SQS. */
export interface SubmitWagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export type WagerSource =
  | { type: 'http' }
  | { type: 'sqs'; consumerName: string; messageId: string };

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: SubmitWagerPayload;
  source: WagerSource;
  correlationId: string;
}

/**
 * USE CASE central: processar uma operação de aposta.
 *
 * Reutilizado pela API HTTP e pelo consumidor SQS (seção 10).
 *
 * Tudo acontece em UMA transação SQL:
 *   inbox (se SQS) + transação + saldo + ledger + outbox
 * → ou tudo é confirmado junto, ou nada é (seção 11).
 *
 * Concorrência: a wallet é travada com SELECT ... FOR UPDATE antes de ler o
 * saldo, então "ler → calcular → gravar" acontece com exclusão mútua POR WALLET.
 * Wallets diferentes continuam em paralelo (não há lock global).
 */
export class ProcessWagerTransactionUseCase {
  private readonly processor = new WagerTransactionProcessor();

  constructor(
    private readonly runner: TransactionRunner,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly settings: WageringSettings,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
  ) {}

  async execute(cmd: SubmitWagerCommand): Promise<WagerOutcome> {
    const startedAt = performance.now();
    const payloadHash = computePayloadHash(cmd.payload as WagerBusinessPayload);

    // Valida o contrato ANTES de abrir transação: payload inválido → ValidationError (400 / DLQ).
    this.buildTransaction(cmd, payloadHash, this.ids.next(), this.clock.now());

    const outcome = await this.runner.run((uow) => this.processInTransaction(uow, cmd, payloadHash));

    this.metrics.observeProcessing(cmd.source.type, (performance.now() - startedAt) / 1000);
    if (outcome.type === 'duplicate_message') {
      this.metrics.duplicateDetected('inbox_redelivery');
    } else if (outcome.idempotentReplay) {
      this.metrics.duplicateDetected('idempotent_replay');
    } else {
      this.metrics.transactionFinished(outcome.status, cmd.payload.kind, cmd.source.type);
    }
    this.logger.info('wager transaction handled', {
      transactionId: outcome.type === 'result' ? outcome.transactionId : undefined,
      status: outcome.type === 'result' ? outcome.status : 'DUPLICATE_MESSAGE',
      failureCode: outcome.type === 'result' ? outcome.failureCode : undefined,
      idempotentReplay: outcome.type === 'result' ? outcome.idempotentReplay : undefined,
      kind: cmd.payload.kind,
    });
    return outcome;
  }

  private async processInTransaction(uow: UnitOfWork, cmd: SubmitWagerCommand, payloadHash: string): Promise<WagerOutcome> {
    const now = this.clock.now();

    // 1. Inbox: esta ENTREGA da fila já foi processada? (dedup por consumerName + messageId)
    if (cmd.source.type === 'sqs') {
      const seen = await uow.inbox.find(cmd.source.consumerName, cmd.source.messageId);
      if (seen) {
        if (seen.payloadHash !== payloadHash) throw new InboxPayloadMismatchError(cmd.source.messageId);
        return { type: 'duplicate_message' };
      }
    }

    // 2. Idempotência (leitura rápida, sem lock): esta OPERAÇÃO já existe?
    //    Replays não precisam disputar o lock da wallet.
    const early = await this.findExisting(uow, cmd, payloadHash);
    if (early) {
      await this.recordInbox(uow, cmd, payloadHash, now);
      return resultFrom(early, true);
    }

    // 3. Trava a wallet. A partir daqui, ninguém mais mexe nela até o COMMIT.
    const wallet = await uow.wallets.findByIdForUpdate(cmd.payload.walletId);

    // 4. Re-checa a idempotência JÁ COM O LOCK: outra requisição com a mesma key
    //    pode ter commitado enquanto esperávamos (ex.: 50 envios em paralelo).
    const existing = await this.findExisting(uow, cmd, payloadHash);
    if (existing) {
      await this.recordInbox(uow, cmd, payloadHash, now);
      return resultFrom(existing, true);
    }

    if (!wallet) {
      await this.recordInbox(uow, cmd, payloadHash, now);
      return walletNotFoundResult();
    }

    // 5. Monta a transação, resolve a referência e aplica as regras de negócio (domínio puro).
    const tx = this.buildTransaction(cmd, payloadHash, this.ids.next(), now);
    const lookup = await lookupReference(uow, tx);
    const ledgerEntryId = this.ids.next();
    const outcome = this.processor.process(tx, wallet, lookup, {
      now,
      ledgerEntryId,
      referenceBackoff: this.settings.referenceBackoff,
      referenceMaxAttempts: this.settings.referenceMaxAttempts,
    });

    // 6. Persiste tudo na mesma transação SQL.
    await uow.transactions.insert(tx);
    await persistOutcome(uow, tx, wallet, outcome, this.eventContext(cmd, now));
    await this.recordInbox(uow, cmd, payloadHash, now);

    return resultFrom(tx, false);
  }

  /**
   * Busca por Idempotency-Key (fonte da verdade). Mesma key + hash diferente = CONFLITO.
   * Também impede o mesmo (providerId, externalTransactionId) com outra key.
   */
  private async findExisting(uow: UnitOfWork, cmd: SubmitWagerCommand, payloadHash: string): Promise<WagerTransaction | null> {
    // As duas buscas são statements separados: uma transação concorrente pode commitar
    // entre elas. Por isso o resultado por externalId também é comparado pela key.
    const byKey =
      (await uow.transactions.findByIdempotencyKey(cmd.idempotencyKey)) ??
      (await uow.transactions.findByExternalId(cmd.payload.providerId, cmd.payload.externalTransactionId));
    if (!byKey) return null;

    if (byKey.idempotencyKey !== cmd.idempotencyKey) {
      throw new ExternalTransactionConflictError(cmd.payload.providerId, cmd.payload.externalTransactionId);
    }
    if (!byKey.matchesPayload(payloadHash)) throw new IdempotencyConflictError(cmd.idempotencyKey);
    return byKey;
  }

  private async recordInbox(uow: UnitOfWork, cmd: SubmitWagerCommand, payloadHash: string, now: Date): Promise<void> {
    if (cmd.source.type !== 'sqs') return;
    const inbox = InboxMessage.receive({
      messageId: cmd.source.messageId,
      consumerName: cmd.source.consumerName,
      payloadHash,
      receivedAt: now,
    });
    inbox.markProcessed(now);
    await uow.inbox.insert(inbox);
  }

  private eventContext(cmd: SubmitWagerCommand, now: Date): EventContext {
    return {
      newId: () => this.ids.next(),
      correlationId: cmd.correlationId,
      causationId: cmd.source.type === 'sqs' ? cmd.source.messageId : cmd.idempotencyKey,
      occurredAt: now,
    };
  }

  private buildTransaction(cmd: SubmitWagerCommand, payloadHash: string, id: string, now: Date): WagerTransaction {
    const p = cmd.payload;
    return WagerTransaction.create({
      id,
      providerId: p.providerId,
      externalTransactionId: p.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash,
      walletId: p.walletId,
      playerId: p.playerId,
      roundId: p.roundId,
      gameId: p.gameId,
      kind: p.kind,
      money: Money.from(p.money),
      referenceExternalTransactionId: p.referenceExternalTransactionId,
      correlationId: cmd.correlationId,
      createdAt: now,
    });
  }
}

// ---------------------------------------------------------------------------
// Funções compartilhadas com o worker de PENDING_REFERENCE (mesmas regras, mesma persistência).
// ---------------------------------------------------------------------------

export async function lookupReference(uow: UnitOfWork, tx: WagerTransaction): Promise<ReferenceLookup> {
  if (tx.referenceExternalTransactionId === undefined) {
    return { reference: undefined, alreadyReversed: false };
  }
  const reference = await uow.transactions.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
  const alreadyReversed = reference ? await uow.transactions.hasProcessedReversal(reference.id) : false;
  return { reference, alreadyReversed };
}

/**
 * Grava o efeito da decisão + os eventos na outbox (mesma transação SQL).
 *   processed → [ledger + wallet] + WagerTransactionProcessed (+ WalletBalanceChanged se o saldo mudou)
 *   rejected  → WagerTransactionRejected (sem ledger, saldo intacto)
 *   pending   → WagerTransactionPendingReference (apenas na PRIMEIRA vez que entra em espera)
 */
export async function persistOutcome(
  uow: UnitOfWork,
  tx: WagerTransaction,
  wallet: Wallet,
  outcome: ProcessOutcome,
  ctx: EventContext,
  options: { emitPendingEvent?: boolean } = {},
): Promise<void> {
  const events: IntegrationEvent<unknown>[] = [];

  if (outcome.type === 'processed') {
    if (outcome.ledgerEntry) {
      await applyBalanceChange(uow, wallet, outcome.ledgerEntry);
      events.push(WalletBalanceChanged.from(wallet, outcome.ledgerEntry, ctx));
    }
    events.unshift(WagerTransactionProcessed.from(tx, ctx));
    // Alguém pode estar esperando por esta transação (REFUND/ROLLBACK chegou antes): antecipa.
    await uow.transactions.expediteDependents(tx.providerId, tx.externalTransactionId, ctx.occurredAt);
  } else if (outcome.type === 'rejected') {
    events.push(WagerTransactionRejected.from(tx, ctx));
  } else if (options.emitPendingEvent ?? true) {
    events.push(WagerTransactionPendingReference.from(tx, ctx));
  }

  for (const event of events) {
    await uow.outbox.add(OutboxMessage.enqueue(event));
  }
}

async function applyBalanceChange(uow: UnitOfWork, wallet: Wallet, entry: WalletLedgerEntry): Promise<void> {
  await uow.ledger.append(entry);
  await uow.wallets.update(wallet);
}
