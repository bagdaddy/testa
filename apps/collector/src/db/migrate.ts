/**
 * Schema migration runner.
 *
 * Reads `apps/collector/db/migrations/*.sql` in alphabetical order and applies
 * any not yet recorded in the `_migrations` tracker table. Idempotent: a second
 * run on a fully-migrated database is a no-op.
 *
 * Run via `pnpm --filter @testa-platform/collector migrate` or directly:
 *   bun run apps/collector/src/db/migrate.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { close, command, query } from './clickhouse.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');

const TRACKER_DDL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    filename   String,
    applied_at DateTime DEFAULT now()
  )
  ENGINE = MergeTree
  ORDER BY filename
`;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/** Apply pending migrations. Returns lists of applied and skipped filenames. */
export async function migrate(dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  await command(TRACKER_DDL);

  const applied = new Set(
    (await query<{ filename: string }>('SELECT filename FROM _migrations')).map((r) => r.filename),
  );

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const result: MigrateResult = { applied: [], skipped: [] };
  for (const file of files) {
    if (applied.has(file)) {
      result.skipped.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    await command(sql);
    await command(`INSERT INTO _migrations (filename) VALUES ('${file.replace(/'/g, "''")}')`);
    result.applied.push(file);
  }
  return result;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  try {
    const { applied, skipped } = await migrate();
    const dt = Date.now() - t0;
    console.log(`[migrate] applied=${applied.length} skipped=${skipped.length} in ${dt}ms`);
    if (applied.length > 0) {
      console.log(`[migrate]   + ${applied.join('\n[migrate]   + ')}`);
    }
  } catch (err) {
    console.error('[migrate] FAILED:', err);
    process.exitCode = 1;
  } finally {
    await close();
  }
}

if (import.meta.main) {
  void main();
}
