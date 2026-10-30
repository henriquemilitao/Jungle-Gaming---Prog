/**
 * Classificação de erros do PostgreSQL pelo SQLSTATE (código padrão do banco),
 * independente de mensagem de texto.
 */
interface PgLikeError {
  code?: string;
  constraint?: string;
  message?: string;
}

const asPg = (e: unknown): PgLikeError => (typeof e === 'object' && e !== null ? (e as PgLikeError) : {});

export const isUniqueViolation = (e: unknown): boolean => asPg(e).code === '23505';
export const violatedConstraint = (e: unknown): string | undefined => asPg(e).constraint;

/** 55P03 lock_not_available: NOWAIT falhou ou lock_timeout estourou. */
export const isLockNotAvailable = (e: unknown): boolean => asPg(e).code === '55P03';
export const isDeadlock = (e: unknown): boolean => asPg(e).code === '40P01';
export const isSerializationFailure = (e: unknown): boolean => asPg(e).code === '40001';
/** 57014 query_canceled (statement_timeout). */
export const isStatementTimeout = (e: unknown): boolean => asPg(e).code === '57014';

const TRANSIENT_NODE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Banco fora do ar / conexão perdida / pool esgotado: vale a pena tentar de novo depois.
 * SQLSTATE classe 08 = connection exception; 57P0x = servidor desligando/reiniciando.
 */
export function isDatabaseUnavailable(e: unknown): boolean {
  const { code, message } = asPg(e);
  if (code && (code.startsWith('08') || code.startsWith('57P') || TRANSIENT_NODE_CODES.has(code))) return true;
  const text = message ?? '';
  return (
    text.includes('Timeout acquiring a connection') ||
    text.includes('Connection terminated') ||
    text.includes('ECONNREFUSED') ||
    text.includes('the database system is starting up') ||
    text.includes('the database system is shutting down')
  );
}
