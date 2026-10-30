import type { Subprocess } from 'bun';
import { resolve } from 'node:path';
import { TEST_DATABASE_URL } from './integration';
import { TEST_SQS_ENDPOINT, type TestQueues } from './sqs';

const ROOT = resolve(import.meta.dir, '../..');
let nextPort = 3400 + Math.floor(Math.random() * 400);

/**
 * Sobe a aplicação de verdade como PROCESSO separado (bun run src/main.ts) —
 * cada instância com seu próprio pool de conexões, memória e consumidor SQS.
 * É assim que provamos que a solução é correta com ≥ 3 instâncias.
 */
export class AppInstance {
  readonly port: number;
  readonly baseUrl: string;
  private proc?: Subprocess;
  private output = '';

  constructor(
    readonly name: string,
    private readonly queues: TestQueues,
    private readonly env: Record<string, string> = {},
  ) {
    this.port = nextPort++;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<this> {
    this.spawn();
    await this.waitReady();
    return this;
  }

  /** Sobe o processo sem esperar ficar pronto (ex.: instância que vai morrer de propósito). */
  spawn(): this {
    this.proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(this.port),
        INSTANCE_ID: this.name,
        DATABASE_URL: TEST_DATABASE_URL,
        DATABASE_POOL_MAX: '15',
        SQS_ENDPOINT: TEST_SQS_ENDPOINT,
        SQS_WAGER_QUEUE: this.queues.wagerQueueName,
        SQS_WAGER_DLQ: this.queues.wagerDlqName,
        SQS_EVENTS_QUEUE: this.queues.eventsQueueName,
        SQS_WAIT_TIME_SECONDS: '1',
        SQS_VISIBILITY_TIMEOUT_SECONDS: '2',
        SQS_MAX_RECEIVE_COUNT: '3',
        SQS_RETRY_BASE_DELAY_SECONDS: '1',
        OUTBOX_POLL_INTERVAL_MS: '100',
        PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
        PENDING_REFERENCE_BASE_DELAY_MS: '100',
        PENDING_REFERENCE_MAX_DELAY_MS: '1000',
        SHUTDOWN_GRACE_MS: '5000',
        LOG_LEVEL: 'warn',
        ...this.env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    void this.capture(this.proc.stdout as ReadableStream<Uint8Array>);
    void this.capture(this.proc.stderr as ReadableStream<Uint8Array>);
    return this;
  }

  /** SIGTERM: shutdown gracioso. */
  async stop(): Promise<number | null> {
    if (!this.proc) return null;
    this.proc.kill('SIGTERM');
    return this.proc.exited;
  }

  /** SIGKILL: morte abrupta (kill -9), sem nenhum cleanup. */
  async kill(): Promise<void> {
    this.proc?.kill('SIGKILL');
    await this.proc?.exited;
  }

  get exited(): Promise<number> {
    return this.proc!.exited;
  }

  get logs(): string {
    return this.output;
  }

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  private async waitReady(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/health/ready`);
        if (res.status === 200) return;
      } catch {
        /* ainda subindo */
      }
      await Bun.sleep(150);
    }
    throw new Error(`${this.name} did not become ready.\n${this.output}`);
  }

  private async capture(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) this.output += decoder.decode(chunk);
  }
}
