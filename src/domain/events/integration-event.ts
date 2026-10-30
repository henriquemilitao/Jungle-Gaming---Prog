/** Campos de rastreio comuns a todos os eventos gerados por uma mesma operação. */
export interface EventContext {
  /** Gera o eventId (UUID v7) — injetado para o domínio não depender de runtime. */
  newId: () => string;
  /** Id que acompanha toda a jornada da requisição/mensagem original. */
  correlationId: string;
  /** O que causou este evento (ex.: messageId da fila ou id da transação). */
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface IntegrationEventEnvelope<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string; // ISO-8601
  version: number;
  data: T;
}

/**
 * Envelope de evento de integração (o "aviso" publicado para outros sistemas).
 *
 * Classe ABSTRATA: não pode ser instanciada; cada evento concreto é uma subclasse
 * que define `eventType` e `version` NO TIPO — nunca como string solta no código
 * que publica. `version` permite evoluir o formato de `data` sem quebrar consumidores.
 *
 * `eventId` é o que o consumidor usa para deduplicar publicações repetidas.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  protected static propsFrom<T>(aggregateId: string, data: T, ctx: EventContext): IntegrationEventProps<T> {
    return {
      eventId: ctx.newId(),
      aggregateId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data,
    };
  }

  /** Envelope serializado gravado no payload da outbox. JSON estável e versionável. */
  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
    if (this.causationId !== undefined) envelope.causationId = this.causationId;
    return envelope;
  }
}
