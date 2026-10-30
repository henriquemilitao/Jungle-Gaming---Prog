import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type MessageSystemAttributeName,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { ApplicationError } from '../../application/errors';
import type { AppLogger, Metrics } from '../../application/observability';
import type { ProcessWagerTransactionUseCase } from '../../application/wagering/process-wager-transaction.use-case';
import type { WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { DomainError } from '../../domain/shared/domain-error';
import { logContext } from '../observability/log-context';
import type { FaultInjector } from '../support/fault-injection';
import type { QueueUrls } from './sqs';
import { wagerMessageSchema, type WagerMessage } from './wager-message.schema';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

export interface ConsumerSettings {
  queueName: string;
  dlqName: string;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
  retryBaseDelaySeconds: number;
  concurrency: number;
  shutdownGraceMs: number;
}

/** Como tratar o resultado de uma mensagem. */
type Decision =
  | { action: 'ack' }
  | { action: 'retry'; reason: string }
  | { action: 'dlq'; reason: string };

/**
 * Consumidor da fila wager-transactions.fifo.
 *
 *   1. Recebe (long polling). A mensagem fica invisível para outros consumidores
 *      durante o visibility timeout.
 *   2. Chama O MESMO use case da API HTTP. Dedup pela inbox persistente.
 *   3. Classifica o resultado:
 *        - sucesso ou rejeição de NEGÓCIO (terminal)  → ack (DeleteMessage)
 *        - erro TRANSITÓRIO (banco fora, lock timeout) → não faz ack; volta para a fila
 *          com backoff exponencial (ChangeMessageVisibility)
 *        - erro PERMANENTE (mensagem inválida, conflito) → DLQ
 *        - tentativas esgotadas (ApproximateReceiveCount) → DLQ
 *   4. O ack só acontece DEPOIS do commit (o use case só retorna após o COMMIT).
 *      Se o processo morrer entre o commit e o ack, a mensagem volta e a inbox a reconhece.
 *
 * Shutdown (SIGTERM): para de buscar, termina a mensagem em andamento e devolve a
 * visibilidade (timeout 0) das que já tinha recebido mas não começou.
 */
export class WagerQueueConsumer {
  private running = false;
  private readonly loops: Promise<void>[] = [];
  private readonly abort = new AbortController();

  constructor(
    private readonly sqs: SQSClient,
    private readonly queues: QueueUrls,
    private readonly useCase: ProcessWagerTransactionUseCase,
    private readonly settings: ConsumerSettings,
    private readonly metrics: Metrics,
    private readonly logger: AppLogger,
    private readonly faults: FaultInjector,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.settings.concurrency; i++) this.loops.push(this.pollLoop(i));
    this.logger.info('sqs consumer started', { queue: this.settings.queueName, concurrency: this.settings.concurrency });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abort.abort(); // interrompe o long polling em curso
    const grace = Bun.sleep(this.settings.shutdownGraceMs).then(() => 'timeout' as const);
    const result = await Promise.race([Promise.allSettled(this.loops).then(() => 'done' as const), grace]);
    this.logger.info('sqs consumer stopped', { result });
  }

  private async pollLoop(worker: number): Promise<void> {
    const queueUrl = await this.queueUrlWithRetry();
    while (this.running) {
      let messages: Message[] = [];
      try {
        const res = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: this.settings.waitTimeSeconds,
            VisibilityTimeout: this.settings.visibilityTimeoutSeconds,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'] as MessageSystemAttributeName[],
          }),
          { abortSignal: this.abort.signal },
        );
        messages = res.Messages ?? [];
      } catch (err) {
        if (!this.running) break;
        this.logger.warn('sqs receive failed; backing off', { worker, error: (err as Error).message });
        await Bun.sleep(1_000);
        continue;
      }

      for (const [index, message] of messages.entries()) {
        if (!this.running) {
          // Shutdown: devolve imediatamente o que não começamos (em ordem, preservando o FIFO).
          await this.releaseAll(queueUrl, messages.slice(index));
          break;
        }
        await this.handle(queueUrl, message);
      }
    }
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const parsed = this.parse(message);
    const ctx = {
      messageId: parsed.ok ? parsed.value.messageId : message.MessageId,
      correlationId: parsed.ok ? (parsed.value.correlationId ?? parsed.value.messageId) : message.MessageId,
      walletId: parsed.ok ? parsed.value.data.walletId : undefined,
      providerId: parsed.ok ? parsed.value.data.providerId : undefined,
    };

    await logContext.run(ctx, async () => {
      let decision: Decision;
      if (!parsed.ok) {
        decision = { action: 'dlq', reason: 'INVALID_MESSAGE' };
        this.logger.warn('invalid message format', { issues: parsed.error });
      } else {
        decision = await this.process(parsed.value, receiveCount);
      }

      try {
        await this.apply(queueUrl, message, decision, receiveCount);
      } catch (err) {
        // Falhou o ack/DLQ: a mensagem reaparece após o visibility timeout e a inbox evita duplicar.
        this.logger.error('failed to settle sqs message', { action: decision.action, error: (err as Error).message });
      }
    });
  }

  private async process(msg: WagerMessage, receiveCount: number): Promise<Decision> {
    try {
      const { idempotencyKey, ...payload } = msg.data;
      const outcome = await this.useCase.execute({
        idempotencyKey,
        payload: { ...payload, kind: payload.kind as WagerTransactionKind },
        source: { type: 'sqs', consumerName: WAGER_CONSUMER_NAME, messageId: msg.messageId },
        correlationId: msg.correlationId ?? msg.messageId,
      });
      if (outcome.type === 'result' && outcome.transactionId) logContext.set({ transactionId: outcome.transactionId });

      // COMMIT feito. Ponto crítico do teste de recuperação: morrer aqui = commit sem ack.
      this.faults.crashIf('crash-after-commit-before-ack');
      return { action: 'ack' };
    } catch (err) {
      return this.classify(err, receiveCount);
    }
  }

  private classify(err: unknown, receiveCount: number): Decision {
    // Payload inválido (Money, kind OPENING, referência ausente...) ou conflito de
    // idempotência: tentar de novo nunca vai funcionar → DLQ para investigação.
    if (err instanceof DomainError) return { action: 'dlq', reason: err.code };
    if (err instanceof ApplicationError && (err.category === 'validation' || err.category === 'conflict')) {
      return { action: 'dlq', reason: err.code };
    }

    // Transitório (ou desconhecido): retry com backoff, até o limite de tentativas.
    const reason = err instanceof ApplicationError ? err.code : 'UNEXPECTED_ERROR';
    if (receiveCount >= this.settings.maxReceiveCount) {
      return { action: 'dlq', reason: `MAX_RECEIVES_EXCEEDED:${reason}` };
    }
    this.logger.warn('message processing failed; will retry', {
      reason,
      receiveCount,
      error: err instanceof Error ? err.message : String(err),
    });
    return { action: 'retry', reason };
  }

  private async apply(queueUrl: string, message: Message, decision: Decision, receiveCount: number): Promise<void> {
    switch (decision.action) {
      case 'ack':
        await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
        return;
      case 'retry': {
        this.metrics.retry('sqs_message');
        const delay = Math.min(this.settings.retryBaseDelaySeconds * 2 ** (receiveCount - 1), 900);
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: delay,
          }),
        );
        return;
      }
      case 'dlq':
        await this.sendToDlq(queueUrl, message, decision.reason);
        return;
    }
  }

  /** Envia para a DLQ (com o motivo) e só então apaga da fila principal. */
  private async sendToDlq(queueUrl: string, message: Message, reason: string): Promise<void> {
    const dlqUrl = await this.queues.get(this.settings.dlqName);
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dlq',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason.slice(0, 256) },
          sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? 'unknown' },
        },
      }),
    );
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    this.metrics.dlqMessage(reason.split(':')[0] ?? reason);
    this.logger.warn('message moved to DLQ', { reason });
  }

  private async releaseAll(queueUrl: string, messages: Message[]): Promise<void> {
    for (const m of messages) {
      try {
        await this.sqs.send(
          new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle, VisibilityTimeout: 0 }),
        );
      } catch {
        /* se falhar, a mensagem volta sozinha após o visibility timeout */
      }
    }
  }

  private parse(message: Message): { ok: true; value: WagerMessage } | { ok: false; error: unknown } {
    try {
      const result = wagerMessageSchema.safeParse(JSON.parse(message.Body ?? ''));
      return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.issues };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async queueUrlWithRetry(): Promise<string> {
    for (;;) {
      try {
        return await this.queues.get(this.settings.queueName);
      } catch (err) {
        if (!this.running) throw err;
        this.logger.warn('waiting for SQS queue to become available', { error: (err as Error).message });
        await Bun.sleep(2_000);
      }
    }
  }
}
