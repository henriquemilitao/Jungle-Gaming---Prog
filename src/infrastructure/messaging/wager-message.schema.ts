import { z } from 'zod';

/** Formato da mensagem na fila wager-transactions.fifo (seção 10). */
export const moneySchema = z.object({ amount: z.string(), currency: z.string() });

export const wagerDataSchema = z.object({
  providerId: z.string().min(1).max(100),
  externalTransactionId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(1).max(300),
  playerId: z.string().uuid(),
  walletId: z.string().uuid(),
  roundId: z.string().min(1).max(200),
  gameId: z.string().min(1).max(200),
  kind: z.enum(['OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK']),
  money: moneySchema,
  referenceExternalTransactionId: z.string().min(1).max(200).optional(),
});

export const wagerMessageSchema = z.object({
  messageId: z.string().min(1).max(200),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string().datetime(),
  correlationId: z.string().min(1).max(200).optional(),
  data: wagerDataSchema,
});

export type WagerMessage = z.infer<typeof wagerMessageSchema>;
