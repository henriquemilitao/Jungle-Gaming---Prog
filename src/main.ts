import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { createContainer } from './container';
import { HttpErrorFilter } from './infrastructure/http/http-error.filter';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const container = await createContainer(config);

  const app = await NestFactory.create(AppModule.forRoot(container), {
    logger: container.logger,
    bufferLogs: false,
  });
  app.useGlobalFilters(new HttpErrorFilter(container.logger));
  // SIGTERM/SIGINT → app.close() dispara os hooks de shutdown (o consumidor termina as
  // mensagens em andamento e devolve as não iniciadas), depois sai com código 0.
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      container.logger.info('signal received', { signal });
      app
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          container.logger.error('error during shutdown', { error: String(err) });
          process.exit(1);
        });
    });
  }

  if (config.workers.httpEnabled) {
    await app.listen(config.port, '0.0.0.0');
    container.logger.info('http server listening', { port: config.port });
  } else {
    await app.init();
    container.logger.info('running without http (worker mode)');
  }
}

bootstrap().catch((err) => {
  process.stderr.write(`${JSON.stringify({ level: 'fatal', msg: 'failed to start', error: String(err?.stack ?? err) })}\n`);
  process.exit(1);
});
