import { createHash } from 'node:crypto';

/**
 * Campos de NEGÓCIO que entram no hash. O header Idempotency-Key, o messageId,
 * occurredAt e qualquer metadado de transporte ficam de fora: a mesma operação
 * enviada por HTTP ou por SQS produz o MESMO hash.
 */
export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/**
 * JSON canônico: chaves ordenadas alfabeticamente em todos os níveis, sem espaços,
 * e campos `undefined` omitidos. Dois objetos com o mesmo conteúdo sempre geram a
 * mesma string, independentemente da ordem em que as chaves chegaram.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** payloadHash = SHA-256 (hex, 64 caracteres) do JSON canônico do subconjunto de negócio. */
export function computePayloadHash(payload: WagerBusinessPayload): string {
  const subset: WagerBusinessPayload = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(subset), 'utf8').digest('hex');
}
