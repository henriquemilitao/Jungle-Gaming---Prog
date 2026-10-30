import type { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { WageringQueries } from './application/queries/queries';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction.use-case';
import { ResolvePendingReferencesUseCase } from './application/wagering/resolve-pending-references.use-case';
import { OpenWalletUseCase } from './application/wallets/open-wallet.use-case';
import { ReconcileWalletUseCase } from './application/wallets/reconcile-wallet.use-case';
import type { AppConfig } from './config';
import { ExponentialBackoff } from './domain/shared/exponential-backoff';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { approximateDepth, createSqsClient, QueueUrls } from './infrastructure/messaging/sqs';
import { WagerQueueConsumer } from './infrastructure/messaging/wager-queue-consumer';
import { createPinoLogger, PinoAppLogger } from './infrastructure/observability/logger';
import { PrometheusMetrics } from './infrastructure/observability/prometheus-metrics';
import { buildOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/mikro-orm-transaction-runner';
import { FaultInjector } from './infrastructure/support/fault-injection';
import { SystemClock, UuidV7Generator } from './infrastructure/support/system';
import { PollingWorker } from './infrastructure/workers/polling-worker';

/**
 * Composition root: o ÚNICO lugar que conhece todas as implementações concretas
 * e as liga às portas. O NestJS recebe os objetos já montados (useValue).
 */
export interface AppContainer {
  config: AppConfig;
  logger: PinoAppLogger;
  metrics: PrometheusMetrics;
  orm: MikroORM;
  sqs: SQSClient;
  queues: QueueUrls;
  openWallet: OpenWalletUseCase;
  processWager: ProcessWagerTransactionUseCase;
  reconcileWallet: ReconcileWalletUseCase;
  queries: WageringQueries;
  consumer: WagerQueueConsumer;
  outboxWorker: PollingWorker;
  pendingReferenceWorker: PollingWorker;
}

export async function createContainer(config: AppConfig): Promise<AppContainer> {
  const logger = new PinoAppLogger(createPinoLogger(config.logLevel, config.instanceId));
  const orm = await MikroORM.init(buildOrmConfig({ databaseUrl: config.database.url, poolMax: config.database.poolMax, connect: false }));
  const sqs = createSqsClient(config.sqs);
  const queues = new QueueUrls(sqs);
  const faults = new FaultInjector(config.faultInjection);

  // Métricas: gauges de outbox lag e DLQ são calculados no scrape.
  let publisher: OutboxPublisher | undefined;
  const metrics = new PrometheusMetrics({
    outboxLagSeconds: () => publisher!.lagSeconds(),
    outboxPending: () => publisher!.pendingCount(),
    dlqDepth: async () => approximateDepth(sqs, await queues.get(config.sqs.wagerDlqName)),
  });

  const runner = new MikroOrmTransactionRunner(
    orm,
    { lockTimeoutMs: config.database.lockTimeoutMs, statementTimeoutMs: config.database.statementTimeoutMs },
    metrics,
    logger,
  );
  const ids = new UuidV7Generator();
  const clock = new SystemClock();
  const w = config.workers;
  const wageringSettings = {
    referenceBackoff: new ExponentialBackoff(w.pendingReferenceBaseDelayMs, w.pendingReferenceMaxDelayMs),
    referenceMaxAttempts: w.pendingReferenceMaxAttempts,
  };

  const processWager = new ProcessWagerTransactionUseCase(runner, ids, clock, wageringSettings, metrics, logger);
  const resolvePending = new ResolvePendingReferencesUseCase(runner, ids, clock, wageringSettings, metrics, logger);

  publisher = new OutboxPublisher(
    orm,
    sqs,
    queues,
    {
      eventsQueueName: config.sqs.eventsQueueName,
      batchSize: w.outboxBatchSize,
      retryBackoff: new ExponentialBackoff(w.outboxRetryBaseMs, w.outboxRetryMaxMs),
    },
    metrics,
    logger,
    faults,
  );

  const consumer = new WagerQueueConsumer(
    sqs,
    queues,
    processWager,
    {
      queueName: config.sqs.wagerQueueName,
      dlqName: config.sqs.wagerDlqName,
      waitTimeSeconds: config.sqs.waitTimeSeconds,
      visibilityTimeoutSeconds: config.sqs.visibilityTimeoutSeconds,
      maxReceiveCount: config.sqs.maxReceiveCount,
      retryBaseDelaySeconds: config.sqs.retryBaseDelaySeconds,
      concurrency: config.sqs.consumerConcurrency,
      shutdownGraceMs: w.shutdownGraceMs,
    },
    metrics,
    logger,
    faults,
  );

  return {
    config,
    logger,
    metrics,
    orm,
    sqs,
    queues,
    openWallet: new OpenWalletUseCase(runner, ids, clock, logger),
    processWager,
    reconcileWallet: new ReconcileWalletUseCase(runner, metrics, logger),
    queries: new WageringQueries(runner),
    consumer,
    outboxWorker: new PollingWorker('outbox-publisher', w.outboxPollIntervalMs, () => publisher!.publishBatch(), logger),
    pendingReferenceWorker: new PollingWorker(
      'pending-reference-resolver',
      w.pendingReferencePollIntervalMs,
      async () => {
        const s = await resolvePending.runOnce();
        return s.processed + s.rejected + s.failed;
      },
      logger,
    ),
  };
}

