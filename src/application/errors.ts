/**
 * Erros da camada de aplicação, cada um com uma CATEGORIA que define como o
 * mundo de fora deve reagir. A camada HTTP mapeia categoria → status, e o
 * consumidor SQS mapeia categoria → ack / retry / DLQ. Um mapeamento só, consistente.
 *
 *   categoria      HTTP   SQS                      provedor deve...
 *   validation     400    DLQ (permanente)         corrigir o payload
 *   conflict       409    DLQ (permanente)         investigar (mesma key, conteúdo diferente)
 *   not_found      404    —                        —
 *   transient      503    retry com backoff        reenviar (Retry-After)
 *
 * Rejeições de NEGÓCIO (saldo insuficiente etc.) não são exceções: são um resultado
 * normal (status REJECTED + failureCode) → HTTP 422, SQS ack.
 */
export type ErrorCategory = 'validation' | 'conflict' | 'not_found' | 'transient';

export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  abstract readonly category: ErrorCategory;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_KEY_CONFLICT';
  readonly category = 'conflict';

  constructor(idempotencyKey: string) {
    super(`Idempotency-Key "${idempotencyKey}" was already used with a different payload`);
  }
}

export class ExternalTransactionConflictError extends ApplicationError {
  readonly code = 'EXTERNAL_TRANSACTION_CONFLICT';
  readonly category = 'conflict';

  constructor(providerId: string, externalTransactionId: string) {
    super(`Transaction ${providerId}/${externalTransactionId} already exists under a different Idempotency-Key`);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  readonly category = 'conflict';

  constructor(playerId: string, currency: string) {
    super(`Player ${playerId} already has a ${currency} wallet`);
  }
}

export class InboxPayloadMismatchError extends ApplicationError {
  readonly code = 'INBOX_PAYLOAD_MISMATCH';
  readonly category = 'conflict';

  constructor(messageId: string) {
    super(`Message ${messageId} was already received with a different payload`);
  }
}

export class NotFoundError extends ApplicationError {
  readonly category = 'not_found';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Banco/fila indisponíveis, lock timeout, etc. Pode dar certo se tentar de novo. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code: string;
  readonly category = 'transient';

  constructor(code: string, message: string, override readonly cause?: unknown) {
    super(message);
    this.code = code;
  }
}

/** Unicidade garantida pelo banco que é REGRA (ex.: uma wallet por player+moeda), não corrida. */
export class UniqueConstraintConflictError extends ApplicationError {
  readonly code = 'UNIQUE_CONSTRAINT_CONFLICT';
  readonly category = 'conflict';

  constructor(readonly constraint: string | undefined) {
    super(`Unique constraint violated: ${constraint ?? 'unknown'}`);
  }
}
