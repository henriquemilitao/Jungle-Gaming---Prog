import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { ALL_SCHEMAS } from './records';
import { Migration20261030120000_initial_schema } from './migrations/Migration20261030120000_initial_schema';

export interface OrmConfigInput {
  databaseUrl: string;
  poolMax: number;
  debug?: boolean;
  /** false = não falha no boot se o banco estiver fora; conecta sob demanda (readiness reporta). */
  connect?: boolean;
}

/**
 * Configuração do MikroORM.
 *
 * - Migrations listadas explicitamente (versionadas no git, ordenadas pelo timestamp do nome,
 *   e reversíveis com up/down) — evita depender de glob/transpilação em runtime com Bun.
 * - `allowGlobalContext: false`: obriga cada operação a usar um EntityManager próprio
 *   (fork / transactional), evitando que requisições concorrentes compartilhem o Identity Map.
 */
export function buildOrmConfig(input: OrmConfigInput): Options {
  return defineConfig({
    clientUrl: input.databaseUrl,
    entities: ALL_SCHEMAS,
    pool: { min: 1, max: input.poolMax },
    debug: input.debug ?? false,
    connect: input.connect ?? true,
    allowGlobalContext: false,
    forceUtcTimezone: true,
    // Decimal → string (exato). Nunca converter para number.
    discovery: { warnWhenNoEntities: true },
    extensions: [Migrator],
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      silent: true,
      migrationsList: [
        { name: 'Migration20261030120000_initial_schema', class: Migration20261030120000_initial_schema },
      ],
    },
  });
}
