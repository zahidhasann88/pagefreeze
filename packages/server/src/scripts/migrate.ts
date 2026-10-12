import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import type { RunnerOption } from 'node-pg-migrate';
import { loadConfig } from '../config.js';

/**
 * Run the SQL migrations in `packages/server/migrations`.
 *
 * node-pg-migrate is used only as a runner: the migrations themselves are plain `.sql`
 * files with `-- Up Migration` / `-- Down Migration` sections, so they can be read,
 * reviewed and applied by hand with `psql -f` without any tooling.
 */

function findMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../migrations'),
    resolve(here, '../../../migrations'),
    resolve(process.cwd(), 'migrations'),
    resolve(process.cwd(), 'packages/server/migrations'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `migrations directory not found; looked in:\n${candidates.map((c) => `  - ${c}`).join('\n')}`,
  );
}

export interface MigrateOptions {
  direction?: 'up' | 'down';
  count?: number;
  databaseUrl?: string;
  migrationsDir?: string;
  log?: (message: string) => void;
}

export async function runMigrations(options: MigrateOptions = {}): Promise<void> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const databaseUrl = options.databaseUrl ?? loadConfig().databaseUrl;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const migrationsDir = options.migrationsDir ?? findMigrationsDir();
  const direction = options.direction ?? 'up';

  log(`migrating ${direction}: ${migrationsDir}`);

  const runnerOptions: RunnerOption = {
    databaseUrl,
    dir: migrationsDir,
    direction,
    migrationsTable: 'pagefreeze_migrations',
    checkOrder: true,
    verbose: false,
    log,
    ...(options.count !== undefined ? { count: options.count } : {}),
  };

  const applied = await runner(runnerOptions);
  log(`applied ${applied.length} migration(s)`);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const direction = process.argv[2] === 'down' ? 'down' : 'up';
  const countArg = process.argv[3];
  runMigrations({
    direction,
    count: direction === 'down' && countArg ? Number.parseInt(countArg, 10) : undefined,
  })
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      process.stderr.write(`migration failed: ${(error as Error).message}\n`);
      process.exit(1);
    });
}
