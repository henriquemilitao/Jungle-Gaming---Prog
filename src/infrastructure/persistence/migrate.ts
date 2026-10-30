/**
 * CLI de migrations (versionadas e reversíveis):
 *   bun run migrate:up       aplica todas as pendentes
 *   bun run migrate:down     desfaz a última aplicada
 *   bun run migrate:status   lista aplicadas e pendentes
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config';
import { buildOrmConfig } from './mikro-orm.config';

export async function runMigrations(direction: 'up' | 'down' | 'status', databaseUrl?: string): Promise<void> {
  const config = loadConfig();
  const orm = await MikroORM.init(
    buildOrmConfig({ databaseUrl: databaseUrl ?? config.database.url, poolMax: 2 }),
  );
  try {
    const migrator = orm.getMigrator();
    if (direction === 'up') {
      const applied = await migrator.up();
      console.log(JSON.stringify({ msg: 'migrations applied', migrations: applied.map((m) => m.name) }));
    } else if (direction === 'down') {
      const reverted = await migrator.down();
      console.log(JSON.stringify({ msg: 'migrations reverted', migrations: reverted.map((m) => m.name) }));
    } else {
      const executed = await migrator.getExecutedMigrations();
      const pending = await migrator.getPendingMigrations();
      console.log(JSON.stringify({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) }));
    }
  } finally {
    await orm.close(true);
  }
}

if (import.meta.main) {
  const direction = (process.argv[2] ?? 'up') as 'up' | 'down' | 'status';
  runMigrations(direction).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
