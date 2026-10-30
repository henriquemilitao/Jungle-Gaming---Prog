import type { LoggerService } from '@nestjs/common';
import pino, { type Logger } from 'pino';
import type { AppLogger, LogFields } from '../../application/observability';
import { logContext } from './log-context';

/**
 * Logs estruturados em JSON (uma linha por evento), prontos para Loki/ELK/CloudWatch.
 *
 * - Campos de rastreio (correlationId, messageId, transactionId, walletId, providerId)
 *   entram automaticamente via `mixin`, a partir do contexto da operação.
 * - Nunca logamos o payload financeiro completo. Como rede de segurança, campos que
 *   costumam carregar dados sensíveis/financeiros são removidos (`redact`).
 */
export function createPinoLogger(level: string, instanceId: string): Logger {
  return pino({
    level,
    base: { service: 'wagering-processor', instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => ({ ...logContext.get() }),
    redact: {
      paths: ['payload', 'body', 'data', 'money', '*.payload', '*.body', '*.money', 'authorization', '*.authorization'],
      remove: true,
    },
  });
}

/** Implementa a porta AppLogger (usada pela aplicação) e o LoggerService do Nest. */
export class PinoAppLogger implements AppLogger, LoggerService {
  constructor(private readonly logger: Logger) {}

  debug(msg: string, fields?: LogFields): void {
    this.logger.debug(this.normalize(fields), msg);
  }
  info(msg: string, fields?: LogFields): void {
    this.logger.info(this.normalize(fields), msg);
  }
  warn(msg: string, fields?: LogFields): void {
    this.logger.warn(this.normalize(fields), msg);
  }
  error(msg: string, fields?: LogFields | string): void {
    this.logger.error(typeof fields === 'string' ? { stack: fields } : this.normalize(fields), msg);
  }

  // --- LoggerService do Nest (logs internos do framework)
  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
  fatal(message: unknown, context?: string): void {
    this.logger.fatal({ context }, String(message));
  }

  private normalize(fields?: LogFields): LogFields {
    if (!fields) return {};
    const out: LogFields = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined) continue;
      out[k] = v instanceof Error ? { name: v.name, message: v.message } : v;
    }
    return out;
  }
}
