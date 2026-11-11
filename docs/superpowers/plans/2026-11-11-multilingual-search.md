# Multilingual Full-Text Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user chose native, inline execution). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hybrid search's keyword half works for documents in any language Postgres has a text search configuration for, and a corpus can mix languages.

**Architecture:** Each document carries a `language` (a Postgres text search configuration name such as `german`, default from `FTS_LANGUAGE`, itself defaulting to `english`). Migration 2 adds `documents.language` and `chunks.language` (a `regconfig`, because `to_tsvector(regconfig, text)` is immutable and so allowed in a generated column) and regenerates `chunks.fts` from it. Existing rows become `english`, which is what they were. `lexicalSearch` looks up the distinct languages among the candidate documents (owner and `documentIds` scoped), runs one keyword query per language with that configuration (so the GIN index still applies), and merges the lists by rank before the existing fusion.

**Tech Stack:** NestJS 12, `pg` 8, Postgres 16 full-text search, Jest 30 ESM (DB specs only in `apps/api/test/api.e2e.spec.ts`, which runs when `E2E_DATABASE_URL` is set).

**Spec:** none, by the user's instruction ("go ahead without writing specs"). The design, approved in chat on 2026-11-11 ("go ahead with recommended option"), is the Architecture paragraph above plus these decisions:

- No automatic language detection and no new dependency; the web UI is unchanged (it uses the default; a language picker belongs to the document-management item).
- The language name is validated against the database's visible `pg_ts_config` list, read once at startup; an unknown name is a `400` that lists the valid ones; a bad `FTS_LANGUAGE` stops startup.
- Changing a document's language (`PUT /documents/:id` with `language`) re-indexes it from stored text (it re-embeds too; simple over clever).
- Identical content is still deduplicated by hash regardless of language: the existing document is returned with its own language.
- CJK has no Postgres parser; documented as a limit (vector search carries it; `simple` is the fallback).
- Out of scope: language detection, a web picker, per-query language, per-language ranking weights.

## Global Constraints

- No new npm dependency; do not change `package-lock.json`.
- Jest 30 ESM has no `jest` global; DB-backed specs live only in `apps/api/test/api.e2e.spec.ts`; `testTimeout` is 30000.
- Dev runs `ts-node --transpile-only`, so injected constructor params keep explicit `@Inject(...)`.
- Existing databases keep every row; every existing document and chunk becomes `english`, so searching a database that never uses the new feature behaves exactly as before.
- Schema changes are a new migration (`migrations/0002-document-language.ts`, appended to `migrations/index.ts`); never edit `0001-baseline.ts`.
- Run e2e tests against a scratch database only (`E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_fts`, already created on the compose `db`), never `rag`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- An existing, populated database must keep matching its English words after migration 2 (Task 1 test, rows inserted before the migration).
- A question made only of stop words in the document's language (for example `die der das` against German) must return nothing, not error (Task 3 test).
- Apostrophes, accents and punctuation in the question (`l'été, c'est ça?`) must not break `to_tsquery` in other configurations (Task 3 test).
- Another user's documents and languages must neither appear in results nor change which queries run (Task 3 test with two owners).
- Language names are normalised (`" German "` is `german`) and anything else is a `400` on paste, upload, update and job enqueue, never a 500 or a job that fails later (Task 2 tests).
- Changing only a document's language must re-index it and change what it matches, with its text, hash and duplicate detection intact (Task 2 test).

---

## File Structure

- Create `apps/api/src/database/migrations/0002-document-language.ts`; modify `migrations/index.ts`.
- Modify `apps/api/src/config.ts` (`ftsLanguage`), `apps/api/src/database/database.service.ts` (`textSearchConfigs`, startup check).
- Modify `apps/api/src/documents/documents.dto.ts`, `documents.service.ts`, `documents.controller.ts`.
- Modify `apps/api/src/jobs/jobs.controller.ts`, `jobs.service.ts`.
- Modify `apps/api/src/query/query.service.ts` (`lexicalSearch`).
- Create `apps/api/test/fts-config.spec.ts`; modify `apps/api/test/migrations-list.spec.ts`, `apps/api/test/api.e2e.spec.ts`.
- Modify `README.md`, `.env.example`, `TODO.md`.

---

### Task 1: Migration 2, configuration, and the list of languages

**Files:**
- Create: `apps/api/src/database/migrations/0002-document-language.ts`
- Modify: `apps/api/src/database/migrations/index.ts`, `apps/api/src/config.ts`, `apps/api/src/database/database.service.ts`
- Create: `apps/api/test/fts-config.spec.ts`
- Modify: `apps/api/test/migrations-list.spec.ts`, `apps/api/test/api.e2e.spec.ts`

**Interfaces:**
- Produces:
  - `AppConfig.ftsLanguage: string` (lower-case configuration name, default `'english'`).
  - `DatabaseService.textSearchConfigs: ReadonlySet<string>` (visible text search configurations; filled by `onModuleInit`).
  - Schema: `documents.language text NOT NULL DEFAULT 'english'`, `chunks.language regconfig NOT NULL DEFAULT 'english'`, `chunks.fts` generated from `to_tsvector(language, coalesce(heading, '') || ' ' || content)`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/fts-config.spec.ts`:

```ts
import { loadConfig } from '../src/config';

describe('loadConfig for FTS_LANGUAGE', () => {
  const saved = process.env.FTS_LANGUAGE;
  afterEach(() => (saved === undefined ? delete process.env.FTS_LANGUAGE : (process.env.FTS_LANGUAGE = saved)));

  it('defaults to english', () => {
    delete process.env.FTS_LANGUAGE;
    expect(loadConfig().ftsLanguage).toBe('english');
  });

  it('normalises case and surrounding spaces', () => {
    process.env.FTS_LANGUAGE = ' German ';
    expect(loadConfig().ftsLanguage).toBe('german');
  });

  it('rejects something that cannot be a configuration name, naming the variable', () => {
    process.env.FTS_LANGUAGE = 'english; drop table documents';
    expect(() => loadConfig()).toThrow(/FTS_LANGUAGE/);
  });
});
```

In `migrations-list.spec.ts` extend the last test: `expect(migrations[1]).toMatchObject({ id: 2, name: 'document_language' });`.

In `api.e2e.spec.ts`:

1. In `'schema migrations on real schemas (e2e)'` update the three tests that assumed a single migration:
   - "builds the whole current schema...": the recorded rows become `[{ id: 1, name: 'baseline' }, { id: 2, name: 'document_language' }]` (ordered by id; add `ORDER BY id` to that query); also expect `columns('documents')` to contain `language` and `columns('chunks')` to contain `language`.
   - "adopts a database from the first release...": the final recorded ids become `[{ id: 1 }, { id: 2 }]` (with `ORDER BY id`); the kept document row now also has `language: 'english'` (select it).
   - "adopts a database that already has the current schema but no tracking table": run `migrations.slice(0, 1)` first (that is the pre-change schema), then `DROP TABLE schema_migrations`, then `runMigrations(scratch.pool, migrations, ctx)` must resolve to length **2**; recorded ids `[1, 2]`.
2. Add to the same block:

```ts
  it('migration 2 gives existing rows the english language and keeps them searchable, then supports other languages', async () => {
    await runMigrations(scratch.pool, migrations.slice(0, 1), ctx);
    const q = (sql: string, p: unknown[] = []) => scratch.pool.query(sql, p);
    const doc = await q("INSERT INTO documents (title, char_count, chunk_count) VALUES ('Old', 12, 1) RETURNING id");
    await q("INSERT INTO chunks (document_id, ordinal, heading, content, embedding) VALUES ($1, 0, 'H', 'The invoices are paid yearly', '[1,0,0,0,0,0,0,0]')", [doc.rows[0].id]);

    expect((await runMigrations(scratch.pool, migrations, ctx)).map((m) => m.id)).toEqual([2]);

    expect((await q('SELECT language FROM documents')).rows).toEqual([{ language: 'english' }]);
    expect((await q('SELECT language::text AS language FROM chunks')).rows).toEqual([{ language: 'english' }]);
    expect((await q("SELECT count(*)::int AS n FROM chunks WHERE fts @@ to_tsquery('english', 'invoice')")).rows[0].n).toBe(1);

    // New chunks are indexed with their own language: German stems "Rechnungen" to "rechnung", English does not.
    const text = 'Die Rechnungen werden jährlich bezahlt';
    const insert = (language: string) =>
      q("INSERT INTO chunks (document_id, ordinal, content, embedding, language) VALUES ($1, 1, $2, '[0,1,0,0,0,0,0,0]', $3::regconfig)", [doc.rows[0].id, text, language]);
    await insert('german');
    await insert('english');
    const hits = await q(
      "SELECT language::text AS language FROM chunks WHERE content = $1 AND fts @@ to_tsquery('german', 'rechnung')",
      [text],
    );
    expect(hits.rows).toEqual([{ language: 'german' }]);
  });
```

3. In `'DatabaseService startup (e2e)'`: the `service()` helper's config gets `ftsLanguage: 'english'` (second parameter `ftsLanguage = 'english'`); the first test's recorded ids become `[{ id: 1 }, { id: 2 }]`; add:

```ts
  it('lists the text search configurations, and refuses an unknown FTS_LANGUAGE naming the choices', async () => {
    const ok = service(8);
    await ok.onModuleInit();
    expect(ok.textSearchConfigs).toEqual(expect.objectContaining(new Set()));
    expect([...ok.textSearchConfigs]).toEqual(expect.arrayContaining(['english', 'german', 'simple']));
    await ok.onModuleDestroy();

    const bad = service(8, 'klingon');
    await expect(bad.onModuleInit()).rejects.toThrow(/FTS_LANGUAGE=klingon.*english.*german/s);
    await bad.onModuleDestroy();
  });
```

(Remove the first `expect(...objectContaining(new Set()))` line if it is awkward; the `arrayContaining` assertion is the real one.)

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_fts NODE_OPTIONS=--experimental-vm-modules npx jest test/fts-config.spec.ts test/migrations-list.spec.ts test/api.e2e.spec.ts -t "FTS_LANGUAGE|real migration list|schema migrations|DatabaseService startup"`
Expected: FAIL (`ftsLanguage` undefined, no migration 2, no `textSearchConfigs`).

- [ ] **Step 3: Implement**

`migrations/0002-document-language.ts`:

```ts
import { Migration } from '../migrator';

/**
 * Per-document language for full-text search. `chunks.language` is a regconfig because a generated column may
 * only use immutable functions and to_tsvector(regconfig, text) is one; a text column would need a cast that
 * is not. Existing rows keep the configuration they were indexed with: english.
 */
export const documentLanguage: Migration = {
  id: 2,
  name: 'document_language',
  async up(client) {
    await client.query("ALTER TABLE documents ADD COLUMN language text NOT NULL DEFAULT 'english'");
    await client.query("ALTER TABLE chunks ADD COLUMN language regconfig NOT NULL DEFAULT 'english'");
    await client.query('DROP INDEX chunks_fts_idx');
    await client.query('ALTER TABLE chunks DROP COLUMN fts');
    await client.query(`
      ALTER TABLE chunks ADD COLUMN fts tsvector
        GENERATED ALWAYS AS (to_tsvector(language, coalesce(heading, '') || ' ' || content)) STORED`);
    await client.query('CREATE INDEX chunks_fts_idx ON chunks USING gin (fts)');
  },
};
```

`migrations/index.ts`: import it and make the list `[baseline, documentLanguage]`.

`config.ts`: add `ftsLanguage: string;` to `AppConfig` (next to `searchMode`) and a helper

```ts
function configName(name: string, fallback: string): string {
  const raw = (process.env[name] ?? fallback).trim().toLowerCase() || fallback;
  if (!/^[a-z_]{1,40}$/.test(raw)) {
    throw new Error(`${name} must be a text search configuration name such as english, german or simple, got "${process.env[name]}"`);
  }
  return raw;
}
```

and `ftsLanguage: configName('FTS_LANGUAGE', 'english'),` in `loadConfig`.

`database.service.ts`: add `textSearchConfigs: ReadonlySet<string> = new Set();` and, in `onModuleInit` after `checkEmbeddingDim()`:

```ts
    await this.loadTextSearchConfigs();
```

with

```ts
  /** The languages full-text search can use here: every text search configuration visible to this database. */
  private async loadTextSearchConfigs(): Promise<void> {
    const { rows } = await this.query<{ cfgname: string }>(
      'SELECT cfgname FROM pg_ts_config WHERE pg_ts_config_is_visible(oid) ORDER BY cfgname',
    );
    this.textSearchConfigs = new Set(rows.map((r) => r.cfgname));
    if (!this.textSearchConfigs.has(this.cfg.ftsLanguage)) {
      throw new Error(
        `FTS_LANGUAGE=${this.cfg.ftsLanguage} is not a text search configuration of this database. ` +
          `Available: ${[...this.textSearchConfigs].join(', ')}.`,
      );
    }
  }
```

- [ ] **Step 4: Run the Step 2 command, expect PASS; then the whole suite**

Run: the Step 2 command, then `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_fts npm test > $WS/suite.txt 2>&1; tail -8 $WS/suite.txt; npm run typecheck`
Expected: new and updated tests pass; the whole suite passes (the existing e2e blocks run the real app through migration 2); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "Add migration 2: a language per document and chunk, full-text search generated from it

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Choosing the language when indexing

**Files:**
- Modify: `apps/api/src/documents/documents.dto.ts`, `documents.service.ts`, `documents.controller.ts`
- Modify: `apps/api/src/jobs/jobs.controller.ts`, `apps/api/src/jobs/jobs.service.ts`
- Modify: `apps/api/test/api.e2e.spec.ts` (new `describeIfDb('document language (e2e)')` block)

**Interfaces:**
- Consumes: `DatabaseService.textSearchConfigs`, `AppConfig.ftsLanguage` (Task 1).
- Produces:
  - `DocumentsService.resolveLanguage(input?: unknown): string` (normalise, default, validate; throws `BadRequestException` listing the valid names).
  - `DocumentSummary.language: string` (so also `DocumentDetail`).
  - `CreateDocumentDto.language?: string`, `UpdateDocumentDto.language?: string`.
  - `DocumentsService.ingestFile(filename, buffer, owner?, language?)`.
  - `POST /documents`, `POST /documents/upload` (multipart text field `language`), `PUT /documents/:id`, `POST /jobs/documents`, `POST /jobs/upload` accept it; chunks are stored with the document's language.

- [ ] **Step 1: Write the failing tests**

Append to `api.e2e.spec.ts` (the boot copies the "request ids" block's, minus the access-line sink and `LOG_FORMAT`):

```ts
describeIfDb('document language (e2e)', () => {
  let app: INestApplication;
  let base: string;
  const GERMAN = 'Die Rechnungen werden jährlich bezahlt. Kündigungen sind monatlich möglich.';

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      EMBEDDING_PROVIDER: 'mock',
      CHAT_PROVIDER: 'mock',
      EMBEDDING_DIM: '256',
      API_KEYS: '',
      DEMO_MODE: '',
      FTS_LANGUAGE: '',
      RATE_LIMIT_PER_MIN: '0',
      RATE_LIMIT_COSTLY_PER_MIN: '0',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/app.setup');
    const { APP_CONFIG } = await import('../src/config');
    const nest = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApp(nest, nest.get(APP_CONFIG));
    await nest.listen(0);
    app = nest;
    base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await app?.close();
  });

  const json = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const upload = (language: string | undefined, text: string, name: string) => {
    const form = new FormData();
    form.append('file', new Blob([text]), name);
    if (language !== undefined) form.append('language', language);
    return fetch(`${base}/documents/upload`, { method: 'POST', body: form });
  };
  const remove = (id: string) => fetch(`${base}/documents/${id}`, { method: 'DELETE' });
  const languagesOf = async (id: string) =>
    (await app.get(DatabaseService).query('SELECT language::text AS l FROM chunks WHERE document_id = $1', [id])).rows.map((r: any) => r.l);

  it('defaults to english, reports the language, and stores it on the chunks', async () => {
    const res = await json('POST', '/documents', { title: 'Invoices en', content: 'The invoices are paid yearly. Unique-marker-one.' });
    const doc = await readJson(res);
    expect(res.status).toBe(201);
    expect(doc.language).toBe('english');
    expect(new Set(await languagesOf(doc.id))).toEqual(new Set(['english']));
    expect((await readJson(await fetch(`${base}/documents/${doc.id}`))).language).toBe('english');
    await remove(doc.id);
  });

  it('indexes a document in the language it is given, normalising case and spaces', async () => {
    const res = await json('POST', '/documents', { title: 'Rechnungen', content: `${GERMAN} Unique-marker-two.`, language: ' German ' });
    const doc = await readJson(res);
    expect(doc.language).toBe('german');
    expect(new Set(await languagesOf(doc.id))).toEqual(new Set(['german']));
    await remove(doc.id);
  });

  it('answers 400 with the valid names for an unknown language on paste, upload, update and both job routes', async () => {
    const ok = await readJson(await json('POST', '/documents', { title: 'Ok', content: 'Some text to keep. Unique-marker-three.' }));
    for (const res of [
      await json('POST', '/documents', { title: 'x', content: 'text', language: 'klingon' }),
      await json('POST', '/documents', { title: 'x', content: 'text', language: 'DE' }),
      await upload('klingon', 'text to index', 'x.txt'),
      await json('PUT', `/documents/${ok.id}`, { language: 'klingon' }),
      await json('POST', '/jobs/documents', { title: 'x', content: 'text', language: 'klingon' }),
      await (async () => {
        const form = new FormData();
        form.append('file', new Blob(['text to index']), 'x.txt');
        form.append('language', 'klingon');
        return fetch(`${base}/jobs/upload`, { method: 'POST', body: form });
      })(),
    ]) {
      expect(res.status).toBe(400);
      expect(JSON.stringify(await readJson(res))).toMatch(/english.*german/s);
    }
    await remove(ok.id);
  });

  it('takes the language from a multipart upload field', async () => {
    const res = await upload('french', 'Les factures sont payées chaque année. Unique-marker-four.', 'factures.txt');
    const doc = await readJson(res);
    expect(res.status).toBe(201);
    expect(doc.language).toBe('french');
    expect(new Set(await languagesOf(doc.id))).toEqual(new Set(['french']));
    await remove(doc.id);
  });

  it('changing only the language re-indexes the document without touching its text, and re-index keeps it', async () => {
    const doc = await readJson(await json('POST', '/documents', { title: 'Switch', content: `${GERMAN} Unique-marker-five.` }));
    expect(doc.language).toBe('english');

    const updated = await readJson(await json('PUT', `/documents/${doc.id}`, { language: 'german' }));
    expect(updated.language).toBe('german');
    expect(updated.chunkCount).toBe(doc.chunkCount);
    expect(new Set(await languagesOf(doc.id))).toEqual(new Set(['german']));
    expect((await readJson(await fetch(`${base}/documents/${doc.id}`))).content).toContain('Kündigungen');

    const again = await readJson(await fetch(`${base}/documents/${doc.id}/reindex`, { method: 'POST' }));
    expect(again.language).toBe('german');
    expect(new Set(await languagesOf(doc.id))).toEqual(new Set(['german']));
    await remove(doc.id);
  });

  it('still refuses an update that changes nothing', async () => {
    const doc = await readJson(await json('POST', '/documents', { title: 'Nothing', content: 'Plain text. Unique-marker-six.' }));
    expect((await json('PUT', `/documents/${doc.id}`, {})).status).toBe(400);
    await remove(doc.id);
  });

  it('returns the existing document, with its own language, when the same text is sent again in another language', async () => {
    const first = await readJson(await json('POST', '/documents', { title: 'Dup', content: 'Same words here. Unique-marker-seven.', language: 'english' }));
    const second = await json('POST', '/documents', { title: 'Dup', content: 'Same words here. Unique-marker-seven.', language: 'german' });
    expect(second.status).toBe(200);
    const body = await readJson(second);
    expect(body).toMatchObject({ id: first.id, duplicate: true, language: 'english' });
    await remove(first.id);
  });

  it('passes the language through the background job routes, resolving the default when it is left out', async () => {
    const jobs = app.get(JobsService);
    const wait = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        const j = await readJson(await fetch(`${base}/jobs/${id}`));
        if (j.status === 'succeeded' || j.status === 'failed') return j;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('job did not finish');
    };
    const text = await readJson(await json('POST', '/jobs/documents', { title: 'Job de', content: `${GERMAN} Unique-marker-eight.`, language: 'german' }));
    const done = await wait(text.id);
    expect(done.status).toBe('succeeded');
    const created = (await readJson(await fetch(`${base}/documents`))).find((d: any) => d.title === 'Job de');
    expect(created.language).toBe('german');
    await remove(created.id);

    const form = new FormData();
    form.append('file', new Blob(['Les factures sont payées. Unique-marker-nine.']), 'job-fr.txt');
    form.append('language', 'french');
    const file = await readJson(await fetch(`${base}/jobs/upload`, { method: 'POST', body: form }));
    expect((await wait(file.id)).status).toBe('succeeded');
    const createdFile = (await readJson(await fetch(`${base}/documents`))).find((d: any) => d.source === 'job-fr.txt');
    expect(createdFile.language).toBe('french');
    await remove(createdFile.id);
    void jobs;
  });
});
```

(Add `import { DatabaseService }` if not already imported; it is, from Task 2 of the migrations work. `JobsService` is already imported. Drop the `jobs`/`void jobs` lines if unused.)

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_fts NODE_OPTIONS=--experimental-vm-modules npx jest test/api.e2e.spec.ts -t "document language"`
Expected: FAIL (no `language` on responses; unknown language accepted).

- [ ] **Step 3: Implement**

`documents.dto.ts`: add to `CreateDocumentDto` and `UpdateDocumentDto`

```ts
  @IsOptional()
  @IsString()
  @MaxLength(40)
  language?: string;
```

and `language: string;` to `DocumentSummary` (document it: "the text search configuration its keyword search uses").

`documents.service.ts`:
- `DocumentRow` gets `language: string;`; `SUMMARY_COLUMNS` becomes `'id, title, source, char_count, chunk_count, created_at, language'`; `toSummary` adds `language: r.language`.
- Add

```ts
  /** The text search configuration for a request: its own, else FTS_LANGUAGE; anything the database does not have is a client error. */
  resolveLanguage(input?: unknown): string {
    if (input != null && typeof input !== 'string') throw new BadRequestException('language must be a text value');
    const name = (input ?? '').trim().toLowerCase() || this.cfg.ftsLanguage;
    if (!this.db.textSearchConfigs.has(name)) {
      throw new BadRequestException(
        `Unknown language "${input}". Use one of: ${[...this.db.textSearchConfigs].join(', ')}.`,
      );
    }
    return name;
  }
```

- `insertChunks(client, documentId, chunks, vectors, language)`: the statement becomes `INSERT INTO chunks (document_id, ordinal, heading, content, embedding, language) SELECT $1, t.ordinal, t.heading, t.content, t.embedding::vector, $6::regconfig FROM unnest(...)` with `language` appended to the parameters.
- `create`: first line `const language = this.resolveLanguage(dto.language);`; the `INSERT INTO documents` gains `language` as `$9` (column list and values); `insertChunks(..., language)`.
- `ingestFile(filename, buffer, owner = DEFAULT_OWNER, language?: string)`: `const resolved = this.resolveLanguage(language);` before extracting; pass `{ title, content, source: filename, language: resolved }` to `create`.
- `rebuild(current, title, content, language = current.language)`: the `UPDATE documents SET ... language = $9` (parameter appended), `insertChunks(..., language)`.
- `update`: the "nothing to change" check includes `dto.language === undefined`, with the message `'Send a new title, new content, a new language, or any of them'`; compute `const language = dto.language !== undefined ? this.resolveLanguage(dto.language) : current.language;` and pass it to `rebuild`.

`documents.controller.ts` `upload`: add parameter `@Body('language') language: unknown` and pass it: `this.documents.ingestFile(file.originalname, file.buffer, owner, language as string | undefined)` (`resolveLanguage` rejects non-strings).

`jobs.controller.ts`: inject `DocumentsService` (`@Inject(DocumentsService) private readonly documents: DocumentsService`, import it); `indexText` enqueues `payload: { ...dto, language: this.documents.resolveLanguage(dto.language) }`; `upload` takes `@Body('language') language: unknown` and uses `payload: { filename: file.originalname, language: this.documents.resolveLanguage(language) }`.

`jobs.service.ts`: the `ingest_file` case passes `job.payload?.language as string | undefined` as the fourth argument of `ingestFile`.

- [ ] **Step 4: Run the Step 2 command, expect PASS; then the whole suite and typecheck**

Expected: 8 new tests pass; suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/api/test
git commit -m "Let documents carry a language: paste, upload, update and jobs

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Search each language with its own configuration, and document it

**Files:**
- Modify: `apps/api/src/query/query.service.ts` (`lexicalSearch`)
- Modify: `apps/api/test/api.e2e.spec.ts` (new `describeIfDb('multilingual keyword search (e2e)')` block)
- Modify: `README.md`, `.env.example`, `TODO.md`

**Interfaces:**
- Consumes: `chunks.language` (Task 1), `DocumentsService.create(dto, owner)` with `language` (Task 2).
- Produces: `lexicalSearch(vector, question, limit, owner, documentIds?)` unchanged in signature, now correct for any stored language.

- [ ] **Step 1: Write the failing tests**

```ts
describeIfDb('multilingual keyword search (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      EMBEDDING_PROVIDER: 'mock',
      CHAT_PROVIDER: 'mock',
      EMBEDDING_DIM: '256',
      API_KEYS: '',
      DEMO_MODE: '',
      FTS_LANGUAGE: '',
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });

  const ids: string[] = [];
  const add = async (title: string, content: string, language: string, owner = 'default') => {
    const doc = await app.get(DocumentsService).create({ title, content, language }, owner);
    ids.push(doc.id);
    return doc;
  };
  afterEach(async () => {
    await Promise.all(ids.splice(0).map((id) => app.get(DatabaseService).query('DELETE FROM documents WHERE id = $1', [id])));
  });

  /** The keyword half only: the mock embeddings are bag-of-words, so a vector match could hide a keyword miss. */
  const lexical = async (question: string, owner = 'default', documentIds?: string[]) => {
    const query = app.get(QueryService);
    const [embedding] = await app.get<EmbeddingProvider>(EMBEDDING_PROVIDER).embed([question]);
    const rows = await (query as any).lexicalSearch(toVector(embedding), question, 20, owner, documentIds);
    return rows.map((r: any) => r.title as string);
  };

  const DE = 'Die Rechnungen werden jährlich bezahlt. Kündigungen sind monatlich möglich.';

  it('finds a German document by an inflected word only when it is indexed as german', async () => {
    await add('DE as german', DE, 'german');
    await add('DE as english', `${DE} Anderer Text.`, 'english');
    // "Rechnung" is "Rechnungen" after German stemming; English leaves "rechnungen" alone.
    expect(await lexical('Rechnung')).toEqual(['DE as german']);
  });

  it('searches a mixed corpus in one question, each document with its own language', async () => {
    await add('DE', DE, 'german');
    await add('EN', 'The invoices are paid yearly and cancellations are monthly.', 'english');
    await add('FR', 'Les factures sont payées chaque année.', 'french');
    expect((await lexical('Rechnung invoice facture')).sort()).toEqual(['DE', 'EN', 'FR']);
  });

  it('keeps the search inside the given documents', async () => {
    const de = await add('DE', DE, 'german');
    await add('EN', 'The invoices are paid yearly.', 'english');
    expect(await lexical('Rechnung invoice', 'default', [de.id])).toEqual(['DE']);
  });

  it('does not look at another user\'s documents or languages', async () => {
    await add('Bob DE', DE, 'german', 'bob');
    await add('Alice EN', 'The invoices are paid yearly.', 'english', 'alice');
    expect(await lexical('Rechnung invoice', 'alice')).toEqual(['Alice EN']);
    expect(await lexical('Rechnung invoice', 'bob')).toEqual(['Bob DE']);
  });

  it('returns nothing, rather than failing, for a question of only stop words in the document language', async () => {
    await add('DE', DE, 'german');
    expect(await lexical('die der das')).toEqual([]);
  });

  it('copes with apostrophes, accents and punctuation in the question', async () => {
    await add('FR', 'Les étés sont chauds. Les factures sont payées.', 'french');
    expect(await lexical("l'été, c'est ça? (vraiment) & | ! :")).toEqual(['FR']);
  });

  it('still answers a question with no matching language present', async () => {
    expect(await lexical('anything at all')).toEqual([]);
  });
});
```

(Imports needed: `EMBEDDING_PROVIDER`, `EmbeddingProvider` (already imported), `toVector` from `../src/database/database.service`, `DatabaseService`, `DocumentsService`, `QueryService` (already imported).)

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_fts NODE_OPTIONS=--experimental-vm-modules npx jest test/api.e2e.spec.ts -t "multilingual keyword search"`
Expected: FAIL (`lexicalSearch` still uses `'english'`: the German-stemmed document is not found by `Rechnung`; the English-tagged one may be).

- [ ] **Step 3: Implement**

Replace `lexicalSearch` in `query.service.ts`:

```ts
  /**
   * Chunks containing any word of the question, best full-text match first. Each document is searched with
   * its own language's configuration, so the languages present are looked up first (this user's documents,
   * within `documentIds` if given) and each gets a query of its own. Scores are still cosine.
   */
  private async lexicalSearch(
    vector: string,
    question: string,
    limit: number,
    owner: string,
    documentIds?: string[],
  ): Promise<RetrievedChunk[]> {
    const tsquery = toOrTsQuery(question);
    if (!tsquery) return [];

    const scope: unknown[] = [owner];
    let docFilter = '';
    if (documentIds?.length) {
      scope.push(documentIds);
      docFilter = 'AND id = ANY($2::uuid[])';
    }
    const { rows: languages } = await this.db.query<{ language: string }>(
      `SELECT DISTINCT language FROM documents WHERE owner_id = $1 ${docFilter}`,
      scope,
    );

    const perLanguage = await Promise.all(
      languages.map(async ({ language }) => {
        const params: unknown[] = [vector, limit, owner, tsquery, language];
        let filter = '';
        if (documentIds?.length) {
          params.push(documentIds);
          filter = 'AND c.document_id = ANY($6::uuid[])';
        }
        const { rows } = await this.db.query<RetrievedChunk & { rank: number }>(
          `SELECT c.id::text            AS "chunkId",
                  c.document_id         AS "documentId",
                  d.title,
                  c.heading,
                  c.content,
                  1 - (c.embedding <=> $1::vector) AS score,
                  ts_rank_cd(c.fts, to_tsquery($5::regconfig, $4)) AS rank
             FROM chunks c
             JOIN documents d ON d.id = c.document_id
            WHERE d.owner_id = $3
              AND c.language = $5::regconfig
              AND c.fts @@ to_tsquery($5::regconfig, $4)
              ${filter}
            ORDER BY rank DESC, c.id
            LIMIT $2`,
          params,
        );
        return rows;
      }),
    );

    // Ranks from different configurations are comparable enough to interleave; ties keep a stable order.
    return perLanguage
      .flat()
      .sort((a, b) => Number(b.rank) - Number(a.rank) || Number(a.chunkId) - Number(b.chunkId))
      .slice(0, limit)
      .map(({ rank: _rank, ...chunk }) => ({ ...chunk, score: Number(chunk.score) }));
  }
```

- [ ] **Step 4: Run the Step 2 command, expect PASS; then the whole suite and typecheck**

Expected: 7 new tests pass; the earlier hybrid/eval e2e tests (English) still pass unchanged; typecheck clean.

- [ ] **Step 5: Check it end to end for real**

On scratch DB `rag_fts` with the mock providers (`EMBEDDING_DIM=64`, port 4300, built API): `curl -F file=@<german .txt> -F language=german localhost:4300/documents/upload` returns `"language":"german"`; `-F language=klingon` returns 400 listing the languages; `POST /query {"question":"Wie werden Rechnungen bezahlt?"}` returns the German document as a source; `psql` shows the chunks' `language`.
Expected: as stated. A deviation gets a `Ruling:` line.

- [ ] **Step 6: Documentation and TODO**

- `README.md`:
  - API table: in the rows for `POST /documents`, `POST /documents/upload` and `PUT /documents/:id`, mention the optional `language`; add a short "Languages" paragraph under "Retrieval details": each document has a `language` (a Postgres text search configuration: `english` by default, `german`, `french`, `spanish`, `simple` for no stemming, ... the response of an unknown name lists them); it controls stemming and stop words for the keyword half of hybrid search; the vector half does not need it; the question needs no language because each document is searched in its own; changing it re-indexes the document; identical text is still one document whichever language is sent; Chinese, Japanese and Korean have no Postgres parser, use `simple` and rely on vector search (`SEARCH_MODE=vector`); the web app uses the default language (set `FTS_LANGUAGE`).
  - Add `FTS_LANGUAGE` to the settings list.
- `.env.example`: after `SEARCH_MODE`, add `# Keyword-search language for documents indexed without a language: a Postgres text search configuration (english, german, french, spanish, ... or simple for no stemming).` and `FTS_LANGUAGE=english`.
- `TODO.md`: tick "Multilingual full-text search" and say what it became (per-document language, default from `FTS_LANGUAGE`).

- [ ] **Step 7: Final suite, then commit**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_fts npm test > $WS/suite.txt 2>&1; tail -8 $WS/suite.txt`
Expected: all pass.

```bash
git add apps/api/src apps/api/test README.md .env.example TODO.md
git commit -m "Search each document in its own language and document the setting

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
