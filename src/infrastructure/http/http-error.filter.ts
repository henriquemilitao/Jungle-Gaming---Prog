import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationError, type ErrorCategory } from '../../application/errors';
import type { AppLogger } from '../../application/observability';
import { InvalidCursorError } from '../../application/queries/queries';
import { DomainError, InvariantViolationError, ValidationError } from '../../domain/shared/domain-error';
import { RequestValidationError } from './schemas';

/**
 * Mapeamento ÚNICO de erro → status HTTP, igual para todos os endpoints.
 * O provedor decide se reenvia olhando só o status (e `error.retryable`), sem
 * precisar interpretar a mensagem de texto:
 *
 *   400 payload inválido ............ não reenviar sem corrigir
 *   404 recurso inexistente ......... não reenviar
 *   409 conflito (idempotência etc.)  não reenviar; investigar
 *   422 rejeição de negócio ......... (vem no corpo da transação, não aqui)
 *   503 falha transitória ........... reenviar com a MESMA Idempotency-Key (Retry-After)
 *   500 erro inesperado ............. reenviar com a mesma key é seguro (idempotente)
 */
const STATUS_BY_CATEGORY: Record<ErrorCategory, number> = {
  validation: 400,
  not_found: 404,
  conflict: 409,
  transient: 503,
};

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, code, message, details } = this.map(error);

    if (status === 503) res.setHeader('Retry-After', '1');
    if (status >= 500) {
      this.logger.error('request failed', { status, code, error: error instanceof Error ? error.message : String(error) });
    }

    const body: Record<string, unknown> = { code, message, retryable: status === 503 || status === 500 };
    if (details !== undefined) body.details = details;
    res.status(status).json({ error: body });
  }

  private map(error: unknown): { status: number; code: string; message: string; details?: unknown } {
    if (error instanceof RequestValidationError) {
      return { status: 400, code: error.code, message: error.message, details: error.details };
    }
    if (error instanceof ApplicationError) {
      return { status: STATUS_BY_CATEGORY[error.category], code: error.code, message: error.message };
    }
    if (error instanceof InvariantViolationError) {
      return { status: 500, code: error.code, message: 'Internal invariant violation' };
    }
    if (error instanceof ValidationError || error instanceof InvalidCursorError) {
      return { status: 400, code: error.code, message: error.message };
    }
    if (error instanceof DomainError) {
      // Erros de domínio que escapam como exceção vêm de entrada inválida (ex.: moeda) → 400.
      return { status: 400, code: error.code, message: error.message };
    }
    if (error instanceof HttpException) {
      // Erros do próprio Nest (ex.: JSON malformado no body, rota inexistente).
      const status = error.getStatus();
      return { status, code: status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST', message: error.message };
    }
    return { status: 500, code: 'INTERNAL_ERROR', message: 'Unexpected error' };
  }
}
