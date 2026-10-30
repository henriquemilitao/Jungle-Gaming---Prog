/**
 * Portas de observabilidade. A implementação concreta (prom-client / pino) fica na
 * infraestrutura; os use cases só registram FATOS ("houve um replay"), sem saber
 * como isso vira métrica ou log.
 */
export interface Metrics {
  transactionFinished(status: string, kind: string, source: string): void;
  duplicateDetected(kind: 'idempotent_replay' | 'inbox_redelivery'): void;
  retry(operation: 'db_transaction' | 'sqs_message' | 'outbox_publish' | 'pending_reference'): void;
  lockConflict(reason: 'contended' | 'timeout' | 'deadlock'): void;
  observeProcessing(source: string, seconds: number): void;
  reconciliationChecked(consistent: boolean): void;
  dlqMessage(reason: string): void;
}

export type LogFields = Record<string, unknown>;

export interface AppLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** Implementações vazias — úteis em testes de unidade. */
export const noopMetrics: Metrics = {
  transactionFinished: () => {},
  duplicateDetected: () => {},
  retry: () => {},
  lockConflict: () => {},
  observeProcessing: () => {},
  reconciliationChecked: () => {},
  dlqMessage: () => {},
};

export const noopLogger: AppLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
