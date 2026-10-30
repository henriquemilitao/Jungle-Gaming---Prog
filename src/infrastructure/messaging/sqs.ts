import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
  type QueueAttributeName,
} from '@aws-sdk/client-sqs';

export interface SqsSettings {
  endpoint: string;
  region: string;
  wagerQueueName: string;
  wagerDlqName: string;
  eventsQueueName: string;
  visibilityTimeoutSeconds: number;
  maxReceiveCount: number;
}

export function createSqsClient(settings: Pick<SqsSettings, 'endpoint' | 'region'>): SQSClient {
  return new SQSClient({
    endpoint: settings.endpoint,
    region: settings.region,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
    maxAttempts: 3,
  });
}

/** Resolve (e memoriza) a URL de cada fila pelo nome. */
export class QueueUrls {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(private readonly client: SQSClient) {}

  get(name: string): Promise<string> {
    let url = this.cache.get(name);
    if (!url) {
      url = this.client.send(new GetQueueUrlCommand({ QueueName: name })).then((r) => r.QueueUrl!);
      url.catch(() => this.cache.delete(name)); // não memoriza falha
      this.cache.set(name, url);
    }
    return url;
  }
}

/**
 * Cria as filas (idempotente): DLQ, fila de entrada com redrive para a DLQ, e fila de eventos.
 *
 * O limite de tentativas é aplicado PELA APLICAÇÃO (ApproximateReceiveCount ≥ maxReceiveCount → DLQ),
 * e o RedrivePolicy do SQS fica como rede de segurança com folga (+2): pega a "mensagem venenosa"
 * que derruba o processo antes de ele conseguir decidir.
 */
export async function ensureQueues(client: SQSClient, s: SqsSettings): Promise<void> {
  const fifo = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };

  const dlq = await client.send(
    new CreateQueueCommand({ QueueName: s.wagerDlqName, Attributes: { ...fifo, MessageRetentionPeriod: '1209600' } }),
  );
  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl!, AttributeNames: ['QueueArn' as QueueAttributeName] }),
  );

  await client.send(
    new CreateQueueCommand({
      QueueName: s.wagerQueueName,
      Attributes: {
        ...fifo,
        VisibilityTimeout: String(s.visibilityTimeoutSeconds),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqAttrs.Attributes!.QueueArn,
          maxReceiveCount: String(s.maxReceiveCount + 2),
        }),
      },
    }),
  );

  await client.send(new CreateQueueCommand({ QueueName: s.eventsQueueName, Attributes: fifo }));
}

export async function approximateDepth(client: SQSClient, queueUrl: string): Promise<number> {
  const res = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages' as QueueAttributeName],
    }),
  );
  return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0);
}
