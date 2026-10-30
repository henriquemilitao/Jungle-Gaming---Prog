import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
} from '@aws-sdk/client-sqs';
import { createSqsClient, ensureQueues, QueueUrls, type SqsSettings } from '../../src/infrastructure/messaging/sqs';

/**
 * SQS REAL (LocalStack/MiniStack do docker compose, ou outro emulador compatível).
 * Cada suíte usa filas com sufixo próprio para não interferir nas outras.
 */
export const TEST_SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

export function testQueueNames(suffix = Math.random().toString(36).slice(2, 8)) {
  return {
    wagerQueueName: `wager-transactions-${suffix}.fifo`,
    wagerDlqName: `wager-transactions-dlq-${suffix}.fifo`,
    eventsQueueName: `wallet-events-${suffix}.fifo`,
  };
}

export type TestQueues = ReturnType<typeof testQueueNames>;

export async function createTestSqs(queues: TestQueues, overrides: Partial<SqsSettings> = {}) {
  const client = createSqsClient({ endpoint: TEST_SQS_ENDPOINT, region: 'us-east-1' });
  const settings: SqsSettings = {
    endpoint: TEST_SQS_ENDPOINT,
    region: 'us-east-1',
    visibilityTimeoutSeconds: 2,
    maxReceiveCount: 3,
    ...queues,
    ...overrides,
  };
  await ensureQueues(client, settings);
  const urls = new QueueUrls(client);

  let dedup = 0;
  return {
    client,
    urls,
    /** Publica uma mensagem de aposta, como faria um provedor. */
    async sendWager(message: unknown, groupId: string): Promise<void> {
      await client.send(
        new SendMessageCommand({
          QueueUrl: await urls.get(queues.wagerQueueName),
          MessageBody: typeof message === 'string' ? message : JSON.stringify(message),
          MessageGroupId: groupId,
          MessageDeduplicationId: `${Date.now()}-${++dedup}-${Math.random()}`,
        }),
      );
    },
    /** Lê (e apaga) tudo que estiver disponível na fila, até ficar vazia por `idleMs`. */
    async drain(queueName: string, idleMs = 1_500): Promise<Message[]> {
      const url = await urls.get(queueName);
      const all: Message[] = [];
      let idleSince = Date.now();
      while (Date.now() - idleSince < idleMs) {
        const res = await client.send(
          new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, MessageAttributeNames: ['All'] }),
        );
        for (const m of res.Messages ?? []) {
          all.push(m);
          await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle }));
          idleSince = Date.now();
        }
      }
      return all;
    },
    close: () => client.destroy(),
  };
}

let msgSeq = 0;
export function wagerMessage<T extends Record<string, unknown>>(data: T, messageId = `msg-${Date.now()}-${++msgSeq}`) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { idempotencyKey: `${data.providerId}:${data.externalTransactionId}`, ...data },
  };
}

export async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 20_000, intervalMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}
