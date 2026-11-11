# Real Migrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user chose native, inline execution). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inline, run-every-start `ALTER ... IF NOT EXISTS` schema setup with versioned, recorded migrations, so every later schema change is one new file.

**Architecture:** A small runner (`migrator.ts`, no new dependency) takes a database-wide advisory lock, reads a `schema_migrations(id, name, applied_at)` table, and runs each pending migration in its own transaction together with its tracking row. Migrations are TypeScript modules (`{ id, name, up(client, { embeddingDim }) }`) in an ordered list, so nothing needs copying into `dist`. `0001-baseline` is today's statements, unchanged and idempotent, so an existing database adopts it without changes and an empty one is built from it. `DatabaseService.onModuleInit` runs the migrations, then the existing `EMBEDDING_DIM` check.

**Tech Stack:** NestJS 12, `pg` 8 (`Pool`, session advisory locks), Jest 30 ESM (DB specs only in `apps/api/test/api.e2e.spec.ts`, which runs when `E2E_DATABASE_URL` is set), Postgres 16 + pgvector.

**Spec:** none, by the user's instruction ("go ahead without writing specs"). The design, approved in chat on 2026-11-11, is the Architecture paragraph above plus these decisions:

- Forward-only. No down migrations; rollback means restoring the backup the deployment guide describes.
- Migrates on start (as today). No separate CLI.
- Refuse to start if the database records a migration this build does not know ("database is newer than this build"), or an id whose recorded name differs from the code's.
- The `EMBEDDING_DIM` check stays, after the migrations. Because the baseline no longer re-runs, "drop the chunks table" stops working as the way to change dimension; the replacement procedure (`TRUNCATE chunks; ALTER ... TYPE vector(N)` then re-index) is documented and verified in Task 3.
- Out of scope: down migrations, a migrate CLI, checksums, changing any table.

## Global Constraints

- No new npm dependency; do not change `package-lock.json`.
- Jest 30 ESM has no `jest` global; DB-backed specs live only in `apps/api/test/api.e2e.spec.ts`; `testTimeout` is 30000.
- Dev runs `ts-node --transpile-only`, so `DatabaseService` keeps explicit `@Inject(APP_CONFIG)`.
- Existing databases must keep every row. `0001-baseline` statements are exactly today's (idempotent) ones.
- Run the e2e suite against a scratch database only (`E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_mig`), never the user's `rag` database or any other project's database.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- A database from the very first release (no `content_hash`, `content`, `embedding_model`, `owner_id`, `fts`, no jobs table, old global unique index) must be adopted with its rows intact (Task 2 test).
- A production database that already has the current schema but no `schema_migrations` table must adopt version 1 without error (Task 2 test: forget the tracking rows, run again).
- Two API instances (or Jest workers) starting at once must apply each migration once (Task 1 test).
- A migration that fails halfway must leave no partial change and no tracking row, and the next start must retry it (Task 1 test).
- An old API image started against a newer database must refuse with a message that says what to do (Task 1 test).

---

## File Structure

- Create `apps/api/src/database/migrator.ts`: `Migration`, `MigrationContext`, `validateMigrations`, `runMigrations`.
- Create `apps/api/src/database/migrations/0001-baseline.ts`: the current schema, as `baseline: Migration`.
- Create `apps/api/src/database/migrations/index.ts`: `export const migrations: readonly Migration[] = [baseline]`.
- Modify `apps/api/src/database/database.service.ts`: call `runMigrations`, keep the dimension check.
- Create `apps/api/test/migrations-list.spec.ts`: no-DB test of list validation and of the real list.
- Modify `apps/api/test/api.e2e.spec.ts`: new `describeIfDb` blocks for the runner, the baseline and the service wiring.
- Modify `README.md`, `docs/deployment.md`, `.env.example`, `apps/api/src/providers/openai.provider.ts` (message), `TODO.md`.

---

### Task 1: The runner

**Files:**
- Create: `apps/api/src/database/migrator.ts`
- Create: `apps/api/test/migrations-list.spec.ts`
- Modify: `apps/api/test/api.e2e.spec.ts` (add imports, helper and a `describeIfDb('migration runner (e2e)')` block at the end)

**Interfaces:**
- Produces:
  - `interface MigrationContext { embeddingDim: number }`
  - `interface Migration { id: number; name: string; up(client: PoolClient, ctx: MigrationContext): Promise<void> }`
  - `validateMigrations(list: readonly Migration[]): void` (throws unless ids are exactly 1..n in order and names are unique and non-empty)
  - `runMigrations(pool: Pool, list: readonly Migration[], ctx: MigrationContext): Promise<Migration[]>` (resolves to the migrations it applied in this call)

- [ ] **Step 1: Write the no-DB test**

`apps/api/test/migrations-list.spec.ts`:

```ts
import { Migration, validateMigrations } from '../src/database/migrator';

const m = (id: number, name: string): Migration => ({ id, name, up: async () => undefined });

describe('validateMigrations', () => {
  it('accepts ids 1..n in order', () => {
    expect(() => validateMigrations([m(1, 'a'), m(2, 'b')])).not.toThrow();
    expect(() => validateMigrations([])).not.toThrow();
  });

  it('rejects a gap, a duplicate id, or the wrong order', () => {
    expect(() => validateMigrations([m(1, 'a'), m(3, 'c')])).toThrow(/1, 2, 3/);
    expect(() => validateMigrations([m(1, 'a'), m(1, 'b')])).toThrow(/1, 2, 3/);
    expect(() => validateMigrations([m(2, 'b'), m(1, 'a')])).toThrow(/1, 2, 3/);
    expect(() => validateMigrations([m(2, 'b')])).toThrow(/1, 2, 3/);
  });

  it('rejects an empty or repeated name', () => {
    expect(() => validateMigrations([m(1, '')])).toThrow(/name/);
    expect(() => validateMigrations([m(1, 'a'), m(2, 'a')])).toThrow(/same name/);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL**

Run: `cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest test/migrations-list.spec.ts`
Expected: FAIL, cannot find module `../src/database/migrator`.

- [ ] **Step 3: Write the e2e runner tests (RED)**

In `apps/api/test/api.e2e.spec.ts` change the pg import to `import { Client, Pool } from 'pg';`, add `import { randomBytes } from 'crypto';` and `import { Migration, runMigrations } from '../src/database/migrator';`. Append:

```ts
/**
 * A throwaway schema inside the test database, with a pool whose search_path points at it, so migration tests
 * never touch the tables the other suites use. The advisory lock is database-wide, which is what we want:
 * a worker migrating the shared schema waits for these tests, and they for it.
 */
async function scratchSchema() {
  const schema = `mig_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: DB });
  await admin.connect();
  await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: DB, max: 4, options: `-c search_path=${schema},public` });
  return {
    schema,
    pool,
    async drop() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

describeIfDb('migration runner (e2e)', () => {
  let scratch: Awaited<ReturnType<typeof scratchSchema>>;
  beforeEach(async () => {
    scratch = await scratchSchema();
  });
  afterEach(async () => {
    await scratch.drop();
  });

  const ctx = { embeddingDim: 8 };
  const create = (id: number, name: string, sql: string): Migration => ({
    id,
    name,
    up: async (client) => void (await client.query(sql)),
  });
  const recorded = async () =>
    (await scratch.pool.query('SELECT id, name FROM schema_migrations ORDER BY id')).rows;

  it('applies pending migrations in order, records them, and applies nothing the second time', async () => {
    const list = [create(1, 'one', 'CREATE TABLE a (x int)'), create(2, 'two', 'CREATE TABLE b (x int)')];
    expect((await runMigrations(scratch.pool, list, ctx)).map((x) => x.id)).toEqual([1, 2]);
    expect(await recorded()).toEqual([
      { id: 1, name: 'one' },
      { id: 2, name: 'two' },
    ]);
    expect(await runMigrations(scratch.pool, list, ctx)).toEqual([]);
  });

  it('runs only the new migration when one is added later', async () => {
    const one = create(1, 'one', 'CREATE TABLE a (x int)');
    await runMigrations(scratch.pool, [one], ctx);
    const two = create(2, 'two', 'CREATE TABLE b (x int)');
    expect((await runMigrations(scratch.pool, [one, two], ctx)).map((x) => x.id)).toEqual([2]);
  });

  it('passes the embedding dimension to a migration', async () => {
    const seen: number[] = [];
    await runMigrations(scratch.pool, [{ id: 1, name: 'dim', up: async (_c, c) => void seen.push(c.embeddingDim) }], ctx);
    expect(seen).toEqual([8]);
  });

  it('rolls a failing migration back completely, keeps earlier ones, and retries it on the next run', async () => {
    const one = create(1, 'one', 'CREATE TABLE a (x int)');
    const broken: Migration = {
      id: 2,
      name: 'broken',
      up: async (client) => {
        await client.query('CREATE TABLE half (x int)');
        await client.query('SELECT 1/0');
      },
    };
    await expect(runMigrations(scratch.pool, [one, broken], ctx)).rejects.toThrow(/Migration 2 \(broken\) failed/);
    expect(await recorded()).toEqual([{ id: 1, name: 'one' }]);
    const half = await scratch.pool.query("SELECT to_regclass('half') AS t");
    expect(half.rows[0].t).toBeNull();

    const fixed = create(2, 'broken', 'CREATE TABLE half (x int)');
    expect((await runMigrations(scratch.pool, [one, fixed], ctx)).map((x) => x.id)).toEqual([2]);
  });

  it('applies each migration once when two runners start at the same time', async () => {
    const list: Migration[] = [
      {
        id: 1,
        name: 'slow',
        up: async (client) => {
          await client.query('CREATE TABLE runs (x int)');
          await client.query('SELECT pg_sleep(0.3)');
          await client.query('INSERT INTO runs VALUES (1)');
        },
      },
    ];
    const results = await Promise.all([runMigrations(scratch.pool, list, ctx), runMigrations(scratch.pool, list, ctx)]);
    expect(results.map((r) => r.length).sort()).toEqual([0, 1]);
    expect((await scratch.pool.query('SELECT count(*)::int AS n FROM runs')).rows[0].n).toBe(1);
  });

  it('refuses a database that has a migration this build does not know', async () => {
    const one = create(1, 'one', 'CREATE TABLE a (x int)');
    await runMigrations(scratch.pool, [one], ctx);
    await scratch.pool.query("INSERT INTO schema_migrations (id, name) VALUES (2, 'from_the_future')");
    await expect(runMigrations(scratch.pool, [one], ctx)).rejects.toThrow(/2 \(from_the_future\).*newer/s);
  });

  it('refuses a database whose recorded name for an id differs from the code', async () => {
    await runMigrations(scratch.pool, [create(1, 'one', 'CREATE TABLE a (x int)')], ctx);
    await expect(runMigrations(scratch.pool, [create(1, 'renamed', 'CREATE TABLE a (x int)')], ctx)).rejects.toThrow(
      /migration 1 is "one".*"renamed"/s,
    );
  });

  it('leaves the lock free for the next runner after a failure', async () => {
    const broken = create(1, 'broken', 'SELECT 1/0');
    await expect(runMigrations(scratch.pool, [broken], ctx)).rejects.toThrow();
    await expect(runMigrations(scratch.pool, [create(1, 'broken', 'SELECT 1')], ctx)).resolves.toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run them, expect FAIL**

Run (scratch DB must exist; see Task 2 step 0 for creating `rag_mig`): `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_mig NODE_OPTIONS=--experimental-vm-modules npx jest test/api.e2e.spec.ts -t "migration runner"`
Expected: FAIL, cannot find module `../src/database/migrator`.

- [ ] **Step 5: Implement the runner**

`apps/api/src/database/migrator.ts`:

```ts
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
```

- [ ] **Step 6: Run both specs, expect PASS**

Run: the Step 2 command, then the Step 4 command.
Expected: `migrations-list` 3/3 pass; `migration runner` 8/8 pass; other e2e blocks skipped by `-t`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/database/migrator.ts apps/api/test/migrations-list.spec.ts apps/api/test/api.e2e.spec.ts
git commit -m "Add a small versioned migration runner with an advisory lock

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The baseline, and wiring it into the service

**Files:**
- Create: `apps/api/src/database/migrations/0001-baseline.ts`
- Create: `apps/api/src/database/migrations/index.ts`
- Modify: `apps/api/src/database/database.service.ts`
- Modify: `apps/api/test/migrations-list.spec.ts` (real list is valid)
- Modify: `apps/api/test/api.e2e.spec.ts` (baseline and service blocks)

**Interfaces:**
- Consumes: `Migration`, `runMigrations`, `validateMigrations` (Task 1).
- Produces: `baseline: Migration` (id 1, name `baseline`); `migrations: readonly Migration[]`; `DatabaseService.onModuleInit()` runs the migrations, then checks the dimension (error text below).

- [ ] **Step 0: A scratch database**

Docker must be running (the compose `db` service, `docker compose up -d db`; port 5433). Then:
`docker compose exec -T db psql -U rag -d postgres -c "CREATE DATABASE rag_mig"` and `docker compose exec -T db psql -U rag -d rag_mig -c "CREATE EXTENSION IF NOT EXISTS vector"`.
Expected: `CREATE DATABASE`, `CREATE EXTENSION`. (Do not start, stop or reconfigure OrbStack for this; if Docker is not running, stop and ask.)

- [ ] **Step 1: Write the failing tests**

Add to `migrations-list.spec.ts`:

```ts
import { migrations } from '../src/database/migrations';

it('the real migration list is valid and starts with the baseline', () => {
  expect(() => validateMigrations(migrations)).not.toThrow();
  expect(migrations[0]).toMatchObject({ id: 1, name: 'baseline' });
});
```

Append to `api.e2e.spec.ts` (imports: `import { migrations } from '../src/database/migrations'; import { DatabaseService } from '../src/database/database.service';`):

```ts
describeIfDb('schema migrations on real schemas (e2e)', () => {
  let scratch: Awaited<ReturnType<typeof scratchSchema>>;
  beforeEach(async () => {
    scratch = await scratchSchema();
  });
  afterEach(async () => {
    await scratch.drop();
  });
  const ctx = { embeddingDim: 8 };
  const indexes = async () =>
    (await scratch.pool.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1', [scratch.schema])).rows.map(
      (r) => r.indexname as string,
    );
  const columns = async (table: string) =>
    (
      await scratch.pool.query(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        [scratch.schema, table],
      )
    ).rows.map((r) => r.column_name as string);

  it('builds the whole current schema on an empty database and records version 1', async () => {
    await runMigrations(scratch.pool, migrations, ctx);
    expect(await columns('documents')).toEqual(
      expect.arrayContaining(['id', 'title', 'source', 'char_count', 'chunk_count', 'created_at', 'content_hash', 'content', 'embedding_model', 'owner_id']),
    );
    expect(await columns('chunks')).toEqual(expect.arrayContaining(['id', 'document_id', 'ordinal', 'heading', 'content', 'embedding', 'fts']));
    expect(await columns('ingestion_jobs')).toEqual(
      expect.arrayContaining(['id', 'kind', 'status', 'title', 'payload', 'file', 'owner_id', 'result', 'error', 'progress_done', 'progress_total', 'created_at', 'started_at', 'finished_at']),
    );
    const idx = await indexes();
    expect(idx).toEqual(
      expect.arrayContaining(['documents_owner_hash_idx', 'ingestion_jobs_queue_idx', 'chunks_document_idx', 'chunks_fts_idx', 'chunks_embedding_idx']),
    );
    expect(idx).not.toContain('documents_content_hash_idx');
    expect((await scratch.pool.query('SELECT id, name FROM schema_migrations')).rows).toEqual([{ id: 1, name: 'baseline' }]);
  });

  it('skips the HNSW index above 2000 dimensions, as before', async () => {
    await runMigrations(scratch.pool, migrations, { embeddingDim: 2001 });
    expect(await indexes()).not.toContain('chunks_embedding_idx');
  });

  it('adopts a database from the first release and keeps its rows', async () => {
    const q = (sql: string, p: unknown[] = []) => scratch.pool.query(sql, p);
    // The schema as the first release created it: no hash, text, model, owner, jobs table or fts column.
    await q(`CREATE TABLE documents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, source text NOT NULL DEFAULT 'paste',
      char_count integer NOT NULL, chunk_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now())`);
    await q(`CREATE TABLE chunks (
      id bigserial PRIMARY KEY, document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      ordinal integer NOT NULL, heading text, content text NOT NULL, embedding vector(8) NOT NULL)`);
    const doc = await q("INSERT INTO documents (title, char_count, chunk_count) VALUES ('Old', 12, 1) RETURNING id");
    await q("INSERT INTO chunks (document_id, ordinal, heading, content, embedding) VALUES ($1, 0, 'H', 'old words here', '[1,0,0,0,0,0,0,0]')", [doc.rows[0].id]);

    await runMigrations(scratch.pool, migrations, ctx);

    const kept = await q('SELECT title, owner_id, content_hash, content FROM documents');
    expect(kept.rows).toEqual([{ title: 'Old', owner_id: 'default', content_hash: null, content: null }]);
    const chunk = await q("SELECT count(*)::int AS n FROM chunks WHERE fts @@ plainto_tsquery('english', 'words')");
    expect(chunk.rows[0].n).toBe(1);
    expect((await q('SELECT id FROM schema_migrations')).rows).toEqual([{ id: 1 }]);
  });

  it('adopts a database that already has the current schema but no tracking table', async () => {
    await runMigrations(scratch.pool, migrations, ctx);
    await scratch.pool.query("INSERT INTO documents (title, char_count, content_hash) VALUES ('Kept', 5, 'h1')");
    await scratch.pool.query('DROP TABLE schema_migrations'); // what a database from before this change looks like

    await expect(runMigrations(scratch.pool, migrations, ctx)).resolves.toHaveLength(1);

    expect((await scratch.pool.query('SELECT title FROM documents')).rows).toEqual([{ title: 'Kept' }]);
    expect((await scratch.pool.query('SELECT id FROM schema_migrations')).rows).toEqual([{ id: 1 }]);
  });
});

describeIfDb('DatabaseService startup (e2e)', () => {
  let scratch: Awaited<ReturnType<typeof scratchSchema>>;
  beforeEach(async () => {
    scratch = await scratchSchema();
  });
  afterEach(async () => {
    await scratch.drop();
  });
  const service = (embeddingDim: number) => {
    const url = new URL(DB!);
    url.searchParams.set('options', `-c search_path=${scratch.schema},public`);
    return new DatabaseService({ databaseUrl: url.toString(), embeddingDim } as AppConfig);
  };

  it('migrates on start and starts again without error', async () => {
    const first = service(8);
    await first.onModuleInit();
    await first.onModuleDestroy();
    const second = service(8);
    await second.onModuleInit();
    expect((await second.query('SELECT id FROM schema_migrations')).rows).toEqual([{ id: 1 }]);
    await second.onModuleDestroy();
  });

  it('refuses to start when EMBEDDING_DIM differs from the chunks table, and says how to change it', async () => {
    const first = service(8);
    await first.onModuleInit();
    await first.onModuleDestroy();
    const other = service(16);
    await expect(other.onModuleInit()).rejects.toThrow(/8 dimensions but EMBEDDING_DIM=16.*README/s);
    await other.onModuleDestroy();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_mig NODE_OPTIONS=--experimental-vm-modules npx jest test/migrations-list.spec.ts test/api.e2e.spec.ts -t "schema migrations|DatabaseService startup|real migration list"`
Expected: FAIL, cannot find module `../src/database/migrations`.

- [ ] **Step 3: Write the baseline**

`apps/api/src/database/migrations/0001-baseline.ts`. Move the statements of `migrate()` (lines 47-113 of `database.service.ts`) into `up(client, { embeddingDim })` verbatim, keeping every comment, replacing `this.query(` with `client.query(` and `dim` with `embeddingDim`. Open with:

```ts
import { Migration } from '../migrator';

/**
 * The schema as it stood when versioned migrations began. Every statement is idempotent, so a database that
 * was built by the old run-on-every-start setup (any release) adopts it unchanged and an empty one is built
 * from it. Do not edit it once released; add a new migration instead.
 */
export const baseline: Migration = {
  id: 1,
  name: 'baseline',
  async up(client, { embeddingDim: dim }) {
    // ...the statements, with `await client.query(...)`...
  },
};
```

(Keep the local name `dim` via destructuring so the `vector(${dim})` and `dim <= 2000` lines stay byte-for-byte.)

`apps/api/src/database/migrations/index.ts`:

```ts
import { Migration } from '../migrator';
import { baseline } from './0001-baseline';

/** Every schema change, in order. Add a new file and append it here; never edit or reorder applied ones. */
export const migrations: readonly Migration[] = [baseline];
```

- [ ] **Step 4: Wire the service**

In `database.service.ts`: add `import { runMigrations } from './migrator'; import { migrations } from './migrations';`, replace `migrate()` with:

```ts
  async onModuleInit(): Promise<void> {
    const applied = await runMigrations(this.pool, migrations, { embeddingDim: this.cfg.embeddingDim });
    await this.checkEmbeddingDim();
    this.logger.log(
      `Schema ready (vector(${this.cfg.embeddingDim}))` +
        (applied.length ? `, applied ${applied.map((m) => `${m.id} ${m.name}`).join(', ')}` : ''),
    );
  }
```

and a private `checkEmbeddingDim()` containing the existing `pg_attribute` query and check, with the error text:

```ts
        `chunks.embedding has ${rows[0]?.dim} dimensions but EMBEDDING_DIM=${dim}. ` +
          'Set EMBEDDING_DIM back to match, or follow "Changing the embedding dimension" in the README.',
```

Remove the old `migrate()` and the line `await this.migrate()` from `onModuleInit`.

- [ ] **Step 5: Run the Step 2 command, expect PASS**

Expected: `migrations-list` 4/4 pass; the e2e blocks (4 + 2 tests) pass.

- [ ] **Step 6: Whole suite, typecheck, build**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_mig npm test > $WS/suite.txt 2>&1; tail -15 $WS/suite.txt; npm run typecheck && npm run build`
Expected: all suites pass (the earlier suite count plus the new tests), typecheck and build clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/database apps/api/test
git commit -m "Move the schema into a recorded baseline migration

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Dimension-change procedure, documentation, TODO

**Files:**
- Modify: `README.md` (line 114 and structure line 173)
- Modify: `docs/deployment.md` (new "Database changes" section under "Operating it")
- Modify: `.env.example` (line 16)
- Modify: `apps/api/src/providers/openai.provider.ts` (message at line ~37)
- Modify: `TODO.md` (tick "Real migrations")

**Interfaces:**
- Consumes: the new startup error text from Task 2 (it points to the README section named below).

- [ ] **Step 1: Verify the replacement procedure for changing dimension, for real**

On scratch DB `rag_mig_dim` (create like Task 2 step 0): start the API with the mock providers and `EMBEDDING_DIM=64`, create one document with text through `POST /documents`, stop it. Restart with `EMBEDDING_DIM=32`: expect refusal naming the README. Then run `TRUNCATE chunks; ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(32);` in psql, start the API at 32, call `POST /documents/reindex`, then `POST /query` and expect the answer to cite the document.
Expected: refusal, `ALTER TABLE` succeeds (the HNSW index is rebuilt by it), `reindexed` is 1, the query returns sources.
If a step fails, record a `Ruling:` with the working procedure and use that in the docs instead.

- [ ] **Step 2: Edit the docs and messages**

README line 114 becomes: `EMBEDDING_DIM` must match the embedding model (1536 for `text-embedding-3-small`). The API refuses to start on a mismatch rather than failing at query time. To change it, see "Changing the embedding dimension" below.` Add a `#### Changing the embedding dimension` subsection directly after the "Switching from mock to OpenAI" note, with the verified SQL (`TRUNCATE chunks; ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(N);`), set `EMBEDDING_DIM`, restart, then `POST /documents/reindex`; documents indexed before source text was stored must be uploaded again. Replace the README structure line with `database/           pg pool, versioned migrations (migrations/), dimension check`. Add a short "Changing the database schema" paragraph for contributors: add `migrations/000N-name.ts`, append to `migrations/index.ts`, never edit an applied one, forward-only.

`docs/deployment.md`: add `### Database changes` under "Operating it": the API applies pending migrations when it starts and records them in `schema_migrations`; take a backup before upgrading to a version that adds one; migrations are forward-only, so going back means restoring that backup; an older image refuses to start on a newer database with a message saying so (do not edit `schema_migrations` by hand); several instances starting together are safe.

`.env.example` line 16: `# Use EMBEDDING_DIM to match the model (nomic-embed-text = 768); see "Changing the embedding dimension" in the README.`

`openai.provider.ts`: replace `(and re-create the chunks table)` with `(see "Changing the embedding dimension" in the README)`.

`TODO.md` line 47: tick, and note what it now is.

- [ ] **Step 3: Check the docs against the code**

Run: `grep -rn "re-create the chunks\|Drop the chunks\|drop the .chunks" README.md docs/deployment.md .env.example apps/api/src; cd apps/api && npm run typecheck`
Expected: no matches, typecheck clean.

- [ ] **Step 4: Full suite, then commit**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_mig npm test > $WS/suite.txt 2>&1; tail -8 $WS/suite.txt`
Expected: all pass.

```bash
git add README.md docs/deployment.md .env.example TODO.md apps/api/src/providers/openai.provider.ts
git commit -m "Document migrations and the new way to change the embedding dimension

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
