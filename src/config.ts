/**
 * Configuração centralizada, lida das variáveis de ambiente.
 *
 * Tudo que muda entre ambientes (local, Docker, testes) passa por aqui,
 * para que o resto do código não leia `process.env` espalhado.
 */
function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) throw new Error(`Env ${name} must be an integer, got "${raw}"`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

export function loadConfig() {
  return {
    instanceId: str('INSTANCE_ID', `instance-${process.pid}`),
    port: int('PORT', 3000),
    logLevel: str('LOG_LEVEL', 'info'),

    database: {
      url: str('DATABASE_URL', 'postgres://postgres:postgres@localhost:5432/wagering'),
      poolMax: int('DATABASE_POOL_MAX', 20),
      /** Tempo máximo esperando o lock de uma wallet antes de virar erro transitório. */
      lockTimeoutMs: int('DATABASE_LOCK_TIMEOUT_MS', 5_000),
      statementTimeoutMs: int('DATABASE_STATEMENT_TIMEOUT_MS', 15_000),
    },

    sqs: {
      endpoint: str('SQS_ENDPOINT', 'http://localhost:4566'),
      region: str('AWS_REGION', 'us-east-1'),
      wagerQueueName: str('SQS_WAGER_QUEUE', 'wager-transactions.fifo'),
      wagerDlqName: str('SQS_WAGER_DLQ', 'wager-transactions-dlq.fifo'),
      eventsQueueName: str('SQS_EVENTS_QUEUE', 'wallet-events.fifo'),
      /** Long polling: quanto tempo o receive espera por mensagens. */
      waitTimeSeconds: int('SQS_WAIT_TIME_SECONDS', 10),
      visibilityTimeoutSeconds: int('SQS_VISIBILITY_TIMEOUT_SECONDS', 30),
      /** Limite de entregas antes de mandar a mensagem para a DLQ. */
      maxReceiveCount: int('SQS_MAX_RECEIVE_COUNT', 5),
      /** Base do backoff (segundos) aplicado via ChangeMessageVisibility em erro transitório. */
      retryBaseDelaySeconds: int('SQS_RETRY_BASE_DELAY_SECONDS', 2),
      consumerConcurrency: int('SQS_CONSUMER_CONCURRENCY', 2),
    },

    workers: {
      httpEnabled: bool('HTTP_ENABLED', true),
      consumerEnabled: bool('CONSUMER_ENABLED', true),
      outboxPublisherEnabled: bool('OUTBOX_PUBLISHER_ENABLED', true),
      pendingReferenceWorkerEnabled: bool('PENDING_REFERENCE_WORKER_ENABLED', true),
      outboxPollIntervalMs: int('OUTBOX_POLL_INTERVAL_MS', 500),
      outboxBatchSize: int('OUTBOX_BATCH_SIZE', 50),
      outboxRetryBaseMs: int('OUTBOX_RETRY_BASE_MS', 1_000),
      outboxRetryMaxMs: int('OUTBOX_RETRY_MAX_MS', 60_000),
      pendingReferencePollIntervalMs: int('PENDING_REFERENCE_POLL_INTERVAL_MS', 1_000),
      pendingReferenceBaseDelayMs: int('PENDING_REFERENCE_BASE_DELAY_MS', 1_000),
      pendingReferenceMaxDelayMs: int('PENDING_REFERENCE_MAX_DELAY_MS', 120_000),
      /** Tentativas de resolver a referência antes de REJECTED/REFERENCE_NOT_FOUND. */
      pendingReferenceMaxAttempts: int('PENDING_REFERENCE_MAX_ATTEMPTS', 10),
      shutdownGraceMs: int('SHUTDOWN_GRACE_MS', 20_000),
    },

    /**
     * Injeção de falhas — usada SOMENTE pelos testes de recuperação para matar o
     * processo em pontos críticos (ex.: depois do commit e antes do ack).
     */
    faultInjection: str('FAULT_INJECTION', ''),
  };
}

export type AppConfig = ReturnType<typeof loadConfig>;
