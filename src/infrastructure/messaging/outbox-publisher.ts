import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { LockMode } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import type { AppLogger, Metrics } from '../../application/observability';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';
import type { ExponentialBackoff } from '../../domain/shared/exponential-backoff';
import { outboxToDomain } from '../persistence/mappers';
import { OutboxMessageRecord } from '../persistence/records';
import type { FaultInjector } from '../support/fault-injection';
import type { QueueUrls } from './sqs';

export interface OutboxPublisherSettings {
  eventsQueueName: string;
  batchSize: number;
  retryBackoff: ExponentialBackoff;
}

const SQS_BATCH_LIMIT = 10;
const PUBLISH_LANES = 5;

/** Hash simples e estável do aggregateId → índice da pista. */
function laneOf(aggregateId: string): number {
  let h = 0;
  for (let i = 0; i < aggregateId.length; i++) h = (h * 31 + aggregateId.charCodeAt(i)) | 0;
  return Math.abs(h) % PUBLISH_LANES;
}

/**
 * Worker da Transactional Outbox: publica os eventos já COMMITADOS.
 *
 * Seguro com vários publishers ao mesmo tempo (todas as instâncias rodam um):
 *   SELECT ... FOR UPDATE SKIP LOCKED
 * Cada publisher "reserva" linhas diferentes; quem chega depois pula as já reservadas
 * em vez de esperar. A reserva dura até o COMMIT que marca published_at.
 *
 * Garantia: AT-LEAST-ONCE.
 *   - Processo morre antes de publicar → linha continua pendente → outra instância publica.
 *   - Processo morre DEPOIS de publicar e ANTES do commit → o evento é publicado de novo.
 *     É seguro: o consumidor deduplica pelo eventId (e a fila FIFO também deduplica pelo
 *     MessageDeduplicationId = eventId numa janela de 5 min — otimização, não garantia).
 * Falha ao publicar → backoff exponencial; nunca desiste (evento confirmado não se perde).
 *
 * Vazão: o lote é dividido em "pistas" por aggregateId (wallet) enviadas em paralelo; dentro
 * de uma pista, a ordem dos eventos de cada wallet é preservada.
 */
export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly settings: OutboxPublisherSettings,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly faults: FaultInjector,
  ) {}

  /** Publica um lote. Devolve quantos eventos foram publicados. */
  async publishBatch(): Promise<number> {
    const queueUrl = await this.queues.get(this.settings.eventsQueueName);

    return this.orm.em.fork().transactional(async (em) => {
      const now = new Date();
      const records = await em.find(
        OutboxMessageRecord,
        { publishedAt: null, nextAttemptAt: { $lte: now } },
        {
          orderBy: { occurredAt: 'asc', id: 'asc' },
          limit: this.settings.batchSize,
          lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, // FOR UPDATE SKIP LOCKED
        },
      );
      if (records.length === 0) return 0;

      // Envio em "pistas" paralelas: cada wallet (aggregateId) cai sempre na mesma pista e,
      // dentro dela, os eventos saem em ordem. Wallets diferentes são publicadas em paralelo.
      const messages = records.map(outboxToDomain);
      const lanes = this.partitionByAggregate(messages);
      const failures = new Map<string, string>();
      await Promise.all(lanes.map((lane) => this.publishLane(queueUrl, lane, failures)));

      let published = 0;
      for (const [index, message] of messages.entries()) {
        const failure = failures.get(message.id);
        if (failure === undefined) {
          message.markPublished(new Date());
          published++;
        } else {
          message.scheduleRetry(new Date(), this.settings.retryBackoff);
          this.metrics.retry('outbox_publish');
        }
        const state = message.toState();
        em.assign(records[index]!, {
          attempts: state.attempts,
          nextAttemptAt: state.nextAttemptAt ?? null,
          publishedAt: state.publishedAt ?? null,
          lastError: failure ? failure.slice(0, 500) : null,
        });
      }

      // Ponto crítico do teste: publicou no SQS, mas morre antes de gravar published_at.
      this.faults.crashIf('crash-after-publish-before-mark');
      if (published > 0) this.logger.debug('outbox events published', { count: published });
      return published;
    });
  }

  private partitionByAggregate(messages: OutboxMessage[]): OutboxMessage[][] {
    const lanes: OutboxMessage[][] = Array.from({ length: PUBLISH_LANES }, () => []);
    for (const m of messages) lanes[laneOf(m.aggregateId)]!.push(m);
    return lanes.filter((l) => l.length > 0);
  }

  /**
   * Publica uma pista em lotes de até 10. Se um evento de uma wallet falhar, os eventos
   * SEGUINTES da mesma wallet neste ciclo não são enviados (ficam para o retry), para não
   * publicá-los fora de ordem.
   */
  private async publishLane(queueUrl: string, lane: OutboxMessage[], failures: Map<string, string>): Promise<void> {
    const blocked = new Set<string>();
    for (let i = 0; i < lane.length; i += SQS_BATCH_LIMIT) {
      const chunk: OutboxMessage[] = [];
      for (const m of lane.slice(i, i + SQS_BATCH_LIMIT)) {
        if (blocked.has(m.aggregateId)) failures.set(m.id, 'skipped: earlier event of the same aggregate failed');
        else chunk.push(m);
      }
      if (chunk.length === 0) continue;
      for (const [id, reason] of await this.send(queueUrl, chunk)) {
        failures.set(id, reason);
        const failed = chunk.find((m) => m.id === id);
        if (failed) blocked.add(failed.aggregateId);
      }
    }
  }

  /** Envia em lote. Devolve os ids que falharam (com o motivo). */
  private async send(queueUrl: string, messages: OutboxMessage[]): Promise<Map<string, string>> {
    const failed = new Map<string, string>();
    try {
      const res = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: messages.map((m, i) => ({
            Id: String(i),
            MessageBody: JSON.stringify(m.payload),
            MessageGroupId: m.aggregateId, // ordem por wallet
            MessageDeduplicationId: m.id, // = eventId
            MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
          })),
        }),
      );
      for (const f of res.Failed ?? []) {
        const message = messages[Number(f.Id)];
        if (message) failed.set(message.id, `${f.Code}: ${f.Message ?? ''}`);
      }
    } catch (err) {
      for (const m of messages) failed.set(m.id, (err as Error).message);
      this.logger.warn('outbox publish failed; scheduled retry', { error: (err as Error).message, count: messages.length });
    }
    return failed;
  }

  async lagSeconds(): Promise<number> {
    const [row] = await this.orm.em
      .fork()
      .execute<{ lag: string | null }[]>(
        `select extract(epoch from (now() - min(occurred_at)))::text as lag from outbox_message where published_at is null`,
      );
    return row?.lag ? Math.max(Number(row.lag), 0) : 0;
  }

  async pendingCount(): Promise<number> {
    const [row] = await this.orm.em
      .fork()
      .execute<{ n: number }[]>(`select count(*)::int as n from outbox_message where published_at is null`);
    return Number(row?.n ?? 0);
  }
}
