import type { AppLogger } from '../../application/observability';

/**
 * Executa `tick` periodicamente até `stop()`.
 * - Se o tick processou algo (retornou > 0), roda de novo logo em seguida (esvazia a fila de trabalho).
 * - Se não havia nada, espera `intervalMs`.
 * - `stop()` espera o tick em andamento terminar (shutdown gracioso).
 */
export class PollingWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly tick: () => Promise<number>,
    private readonly logger: AppLogger,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info('worker started', { worker: this.name });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info('worker stopped', { worker: this.name });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let handled = 0;
      try {
        handled = await this.tick();
      } catch (err) {
        this.logger.warn('worker tick failed', { worker: this.name, error: (err as Error).message });
      }
      if (handled > 0 || !this.running) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.intervalMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
}
