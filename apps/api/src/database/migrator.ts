import { Pool, PoolClient } from 'pg';

export interface MigrationContext {
  /** The configured EMBEDDING_DIM, for statements that create `vector(N)` columns. */
  embeddingDim: number;
}

export interface Migration {
  /** 1, 2, 3, ... in order, never reused. */
  id: number;
  /** Recorded next to the id; renaming an applied migration is refused. */
  name: string;
  /** Runs inside a transaction together with the row that records it. */
  up(client: PoolClient, ctx: MigrationContext): Promise<void>;
}

/** Arbitrary constant. Every instance of this app takes the same database-wide lock while it migrates. */
const LOCK_KEY = 4815162342;

export function validateMigrations(list: readonly Migration[]): void {
  const names = new Set<string>();
  list.forEach((m, i) => {
    if (m.id !== i + 1) {
      throw new Error(`Migration ids must be 1, 2, 3, ... in order; position ${i + 1} is id ${m.id} (${m.name}).`);
    }
    if (!m.name) throw new Error(`Migration ${m.id} needs a name.`);
    if (names.has(m.name)) throw new Error(`Two migrations have the same name "${m.name}".`);
    names.add(m.name);
  });
}

/**
 * Bring the database up to date and return the migrations applied by this call. Safe to run from several
 * instances at once (they queue on an advisory lock), and a failed migration is rolled back whole.
 */
export async function runMigrations(
  pool: Pool,
  list: readonly Migration[],
  ctx: MigrationContext,
): Promise<Migration[]> {
  validateMigrations(list);
  const applied: Migration[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id         integer PRIMARY KEY,
          name       text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM schema_migrations ORDER BY id',
      );
      const known = new Map(list.map((m) => [m.id, m]));
      for (const row of rows) {
        const m = known.get(row.id);
        if (!m) {
          throw new Error(
            `The database has migration ${row.id} (${row.name}), which this version of the API does not know. ` +
              'The database is newer than this build: upgrade the API, or restore a backup taken before the upgrade.',
          );
        }
        if (m.name !== row.name) {
          throw new Error(
            `In the database migration ${row.id} is "${row.name}" but this build calls it "${m.name}". ` +
              'An applied migration must not be renamed or reordered.',
          );
        }
      }
      const done = new Set(rows.map((r) => r.id));
      for (const m of list) {
        if (done.has(m.id)) continue;
        await client.query('BEGIN');
        try {
          await m.up(client, ctx);
          await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1, $2)', [m.id, m.name]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${m.id} (${m.name}) failed: ${err instanceof Error ? err.message : err}`, {
            cause: err,
          });
        }
        applied.push(m);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK_KEY]);
    }
  } finally {
    client.release();
  }
  return applied;
}
