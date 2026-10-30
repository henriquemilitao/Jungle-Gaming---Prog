import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { Metrics } from '../../application/observability';

export interface GaugeSources {
  /** Idade (s) do evento mais antigo ainda não publicado na outbox. */
  outboxLagSeconds: () => Promise<number>;
  outboxPending: () => Promise<number>;
  /** Mensagens paradas na DLQ (ApproximateNumberOfMessages). */
  dlqDepth: () => Promise<number>;
}

/**
 * Métricas no formato Prometheus, expostas em GET /metrics.
 *
 * Contadores/histogramas são incrementados pelos use cases e workers. Os gauges
 * de outbox lag e profundidade da DLQ são calculados NA HORA da coleta (scrape),
 * consultando banco/SQS — assim refletem o estado global, não só desta instância.
 */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações finalizadas por status, tipo e origem',
    labelNames: ['status', 'kind', 'source'] as const,
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicatas detectadas (replay idempotente ou redelivery da fila)',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas por operação',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Conflitos de lock na wallet (contended = precisou esperar)',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência de processamento de uma transação de aposta',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: 'wagering_reconciliations_total',
    help: 'Reconciliações executadas, por resultado',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });
  private readonly dlqMessages = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens enviadas para a DLQ por esta instância, por motivo',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  constructor(sources?: GaugeSources) {
    if (!sources) return;
    const safe = async (fn: () => Promise<number>) => {
      try {
        return await fn();
      } catch {
        return -1; // fonte indisponível: valor sentinela em vez de quebrar o scrape
      }
    };
    new Gauge({
      name: 'wagering_outbox_lag_seconds',
      help: 'Idade do evento mais antigo pendente de publicação',
      registers: [this.registry],
      async collect() {
        this.set(await safe(sources.outboxLagSeconds));
      },
    });
    new Gauge({
      name: 'wagering_outbox_pending_messages',
      help: 'Eventos ainda não publicados na outbox',
      registers: [this.registry],
      async collect() {
        this.set(await safe(sources.outboxPending));
      },
    });
    new Gauge({
      name: 'wagering_dlq_depth',
      help: 'Mensagens na DLQ (ApproximateNumberOfMessages)',
      registers: [this.registry],
      async collect() {
        this.set(await safe(sources.dlqDepth));
      },
    });
  }

  transactionFinished(status: string, kind: string, source: string): void {
    this.transactions.inc({ status, kind, source });
  }
  duplicateDetected(kind: 'idempotent_replay' | 'inbox_redelivery'): void {
    this.duplicates.inc({ kind });
  }
  retry(operation: string): void {
    this.retries.inc({ operation });
  }
  lockConflict(reason: string): void {
    this.lockConflicts.inc({ reason });
  }
  observeProcessing(source: string, seconds: number): void {
    this.latency.observe({ source }, seconds);
  }
  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({ result: consistent ? 'consistent' : 'mismatch' });
  }
  dlqMessage(reason: string): void {
    this.dlqMessages.inc({ reason });
  }
}
