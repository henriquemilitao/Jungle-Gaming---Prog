import {
  Inject,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type NestModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { WageringQueries } from './application/queries/queries';
import { ProcessWagerTransactionUseCase } from './application/wagering/process-wager-transaction.use-case';
import { OpenWalletUseCase } from './application/wallets/open-wallet.use-case';
import { ReconcileWalletUseCase } from './application/wallets/reconcile-wallet.use-case';
import type { AppContainer } from './container';
import { NoopProviderIdentity, PROVIDER_IDENTITY, ProviderAuthGuard } from './infrastructure/http/auth';
import { WageringController, WalletsController } from './infrastructure/http/controllers';
import { CONTAINER, HealthController, MetricsController } from './infrastructure/http/ops.controllers';
import { logContext } from './infrastructure/observability/log-context';

/** Liga/desliga consumidor e workers junto com o ciclo de vida do Nest (inclui SIGTERM). */
class Lifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(CONTAINER) private readonly c: AppContainer) {}

  onApplicationBootstrap(): void {
    const w = this.c.config.workers;
    if (w.consumerEnabled) this.c.consumer.start();
    if (w.outboxPublisherEnabled) this.c.outboxWorker.start();
    if (w.pendingReferenceWorkerEnabled) this.c.pendingReferenceWorker.start();
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.c.logger.info('shutting down', { signal });
    // 1) para de consumir e termina o que está em andamento; 2) para os workers; 3) fecha conexões.
    await this.c.consumer.stop();
    await Promise.all([this.c.outboxWorker.stop(), this.c.pendingReferenceWorker.stop()]);
    await this.c.orm.close(true);
    this.c.sqs.destroy();
    this.c.logger.info('shutdown complete');
  }
}

/** Middleware de correlação: aceita X-Correlation-Id do cliente ou gera um; devolve no response. */
function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  const correlationId = incoming && incoming.length <= 200 ? incoming : Bun.randomUUIDv7();
  res.setHeader('X-Correlation-Id', correlationId);
  logContext.run({ correlationId }, () => next());
}

@Module({})
export class AppModule implements NestModule {
  static forRoot(container: AppContainer): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, HealthController, MetricsController],
      providers: [
        { provide: CONTAINER, useValue: container },
        { provide: OpenWalletUseCase, useValue: container.openWallet },
        { provide: ProcessWagerTransactionUseCase, useValue: container.processWager },
        { provide: ReconcileWalletUseCase, useValue: container.reconcileWallet },
        { provide: WageringQueries, useValue: container.queries },
        { provide: PROVIDER_IDENTITY, useClass: NoopProviderIdentity },
        ProviderAuthGuard,
        Lifecycle,
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware).forRoutes('*');
  }
}
