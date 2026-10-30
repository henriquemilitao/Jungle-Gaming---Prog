import { GetQueueAttributesCommand, type QueueAttributeName } from '@aws-sdk/client-sqs';
import { Controller, Get, Header, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AppContainer } from '../../container';

export const CONTAINER = Symbol('AppContainer');

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([promise, Bun.sleep(ms).then(() => Promise.reject(new Error(`timeout after ${ms}ms`)))]);

/**
 * Health checks — SEM autenticação.
 *   /health/live  → o processo está de pé (não depende de nada externo; usado para reiniciar o container)
 *   /health/ready → Postgres e SQS respondem (usado para tirar a instância do balanceador)
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(CONTAINER) private readonly c: AppContainer) {}

  @Get('live')
  live() {
    return { status: 'ok', instanceId: this.c.config.instanceId };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.c.orm.em.fork().execute('select 1')),
      this.check(async () => {
        const url = await this.c.queues.get(this.c.config.sqs.wagerQueueName);
        await this.c.sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn' as QueueAttributeName] }),
        );
      }),
    ]);
    const ok = postgres === 'up' && sqs === 'up';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'not_ready', checks: { postgres, sqs } };
  }

  private async check(fn: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await withTimeout(fn(), 2_000);
      return 'up';
    } catch {
      return 'down';
    }
  }
}

/** Métricas Prometheus — sem autenticação (em produção ficaria numa porta/rede interna). */
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(CONTAINER) private readonly c: AppContainer) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics() {
    return this.c.metrics.registry.metrics();
  }
}
