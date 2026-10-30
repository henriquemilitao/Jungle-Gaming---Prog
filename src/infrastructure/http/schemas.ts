import { z } from 'zod';
import { ValidationError } from '../../domain/shared/domain-error';
import { moneySchema, wagerDataSchema } from '../messaging/wager-message.schema';

/*
 * Validação do FORMATO dos contratos HTTP (tipos, campos obrigatórios, tamanhos).
 * As regras de valor (ex.: "25.00" com 2 casas, moeda ISO) ficam no domínio (Money.from),
 * para valerem igualmente para HTTP e SQS.
 */

export const openWalletSchema = z.object({
  playerId: z.string().uuid(),
  initialBalance: moneySchema,
});

/** Mesmo formato do `data` da mensagem SQS, sem a idempotencyKey (que vem no header). */
export const submitWagerSchema = wagerDataSchema.omit({ idempotencyKey: true });

export const idempotencyKeySchema = z.string().trim().min(1).max(300);
export const uuidParam = z.string().uuid();

export const ledgerQuerySchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export class RequestValidationError extends ValidationError {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super('INVALID_PAYLOAD', message);
  }
}

export function parse<T>(schema: z.ZodType<T>, input: unknown, what = 'request'): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new RequestValidationError(
      `Invalid ${what}`,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}
