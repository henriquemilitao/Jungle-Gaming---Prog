import type { IntegrationEvent } from '../events/integration-event';
import { ExponentialBackoff } from '../shared/exponential-backoff';
import { InvariantViolationError } from '../shared/domain-error';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * "Caixa de saída" — Transactional Outbox.
 *
 * Em vez de publicar o evento direto na fila (o que poderia acontecer antes do
 * commit, ou se perder se o processo morrer), o evento é GRAVADO nesta tabela
 * na mesma transação SQL da alteração financeira. Um worker publica depois.
 *
 * Garantia resultante: at-least-once. Pode publicar 2x (se morrer entre publicar
 * e marcar), mas nunca perde; o consumidor deduplica pelo eventId (= id daqui).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem na outbox é o próprio eventId: um evento = uma linha. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      event.occurredAt,
      0,
      event.occurredAt, // elegível para publicação imediatamente
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    }
    this._publishedAt = at;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff). Nunca desiste: evento confirmado não pode ser perdido. */
  scheduleRetry(now: Date, backoff: ExponentialBackoff = new ExponentialBackoff(1_000, 60_000)): void {
    if (!this.isPending()) {
      throw new InvariantViolationError(`Outbox message ${this.id} already published`);
    }
    this._nextAttemptAt = backoff.nextAttemptAt(now, this._attempts);
    this._attempts += 1;
  }

  toState(): OutboxMessageState {
    return {
      id: this.id,
      aggregateId: this.aggregateId,
      eventType: this.eventType,
      payload: this.payload,
      occurredAt: this.occurredAt,
      attempts: this._attempts,
      nextAttemptAt: this._nextAttemptAt,
      publishedAt: this._publishedAt,
    };
  }
}
