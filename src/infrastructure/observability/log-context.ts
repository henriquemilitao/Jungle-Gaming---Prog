import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de rastreio da operação corrente (requisição HTTP ou mensagem SQS).
 * Fica num AsyncLocalStorage: todo log emitido dentro da operação, em qualquer
 * camada, sai automaticamente com esses campos — sem precisar repassá-los à mão.
 */
export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const logContext = {
  run<T>(ctx: LogContext, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...ctx }, fn);
  },
  get(): LogContext {
    return storage.getStore() ?? {};
  },
  /** Completa o contexto corrente (ex.: transactionId descoberto no meio do processamento). */
  set(fields: Partial<LogContext>): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },
};
