/**
 * Prepara o ambiente: aplica as migrations e cria as filas SQS (idempotente).
 * Rodado pelo serviço `setup` do docker compose, ou manualmente: `bun run scripts/setup.ts`.
 */
import { loadConfig } from '../src/config';
import { createSqsClient, ensureQueues } from '../src/infrastructure/messaging/sqs';
import { runMigrations } from '../src/infrastructure/persistence/migrate';

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations('up');

  const sqs = createSqsClient(config.sqs);
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureQueues(sqs, config.sqs);
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      console.log(JSON.stringify({ msg: 'waiting for SQS', attempt, error: (err as Error).message }));
      await Bun.sleep(2_000);
    }
  }
  sqs.destroy();
  console.log(JSON.stringify({ msg: 'setup complete' }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
