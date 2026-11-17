# Metadata Filters and Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (the user chose native, inline execution). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Documents can be tagged, and a question can be narrowed by tag, source or indexing date as well as by `documentIds`, in both halves of hybrid search.

**Architecture:** Migration 3 adds `documents.tags text[]` (default `{}`) with a GIN index. A pure `normalizeTags` function is the one place tags are cleaned and validated. A pure `documentFilterSql(filter, alias, firstParam)` turns a `DocumentFilter { documentIds, tags, source, createdAfter, createdBefore }` into an `AND ...` SQL fragment plus parameters for the `documents` alias; it replaces the bare `documentIds` argument that is threaded through `QueryService`, so vector search, keyword search and the keyword search's language lookup filter identically. Filters combine with AND; `tags` matches documents with ANY of the tags.

**Tech Stack:** NestJS 12, `pg` 8, Postgres 16 (`text[]`, GIN, `&&`), class-validator, Jest 30 ESM (DB specs only in `apps/api/test/api.e2e.spec.ts`, which runs when `E2E_DATABASE_URL` is set).

**Spec:** none, by the user's instruction ("go ahead without writing specs"). The design, approved in chat on 2026-11-11 ("go"), is the Architecture paragraph above plus these decisions:

- Tags are free-form: trimmed, lower-cased, whitespace collapsed, de-duplicated, sorted; at most 20 per document, each at most 40 characters, made of letters, numbers, spaces and `_ - . : / + #` (anything else is a `400`). A comma always separates tags, so `"a,b"` is two tags, in JSON arrays and in multipart fields alike.
- Tags come as `tags: string[]` (JSON routes) or a comma-separated `tags` multipart text field, repeatable (upload routes).
- `PUT /documents/:id` with `tags` replaces the set (`[]` clears it); `null` means "not sent". A tags-only update is a plain `UPDATE` (no re-embedding, works for documents without stored text); combined with title, content or language it goes through the existing re-index path.
- Identical content sent again with other tags returns the existing document with its own tags (same rule as `language`).
- A document's date is when it was indexed (`created_at`). `createdAfter` is inclusive, `createdBefore` exclusive, both ISO 8601; a value without a time zone is read in the API server's local zone, so clients should send `Z` or an offset (documented). Values are converted to an instant in the API, so the result does not depend on the database session's zone.
- `source` is an exact match on the document's `source`.
- `GET /documents` accepts `tag` (repeatable or comma-separated, any-of) and `source`; `GET /documents/tags` returns `[{ tag, count }]` for the caller's documents. Both owner-scoped. The web app is unchanged.
- Out of scope: a tag/filter UI (belongs to the document-management item), all-of tag matching, tag rename/merge, free-form JSON metadata, extracting dates from document text.

## Global Constraints

- No new npm dependency; do not change `package-lock.json`.
- Jest 30 ESM has no `jest` global; DB-backed specs live only in `apps/api/test/api.e2e.spec.ts`; `testTimeout` is 30000.
- Dev runs `ts-node --transpile-only`, so injected constructor params keep explicit `@Inject(...)`.
- The global `ValidationPipe` uses `whitelist` and `forbidNonWhitelisted`: every new body field needs a DTO decorator.
- Schema change is a new migration (`migrations/0003-document-tags.ts`, appended to `migrations/index.ts`); never edit migrations 1 or 2.
- With no filters and no tags, every existing behaviour and SQL result is unchanged.
- Run e2e tests against a scratch database only (`E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_tags`, create it on the compose `db`), never `rag`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

- Tag input edge cases never produce a 500: case and spacing, duplicates, empty parts, `"a,,b"`, a repeated multipart field, 21 tags, a 41-character tag, characters outside the allowed set, a non-text element (Task 1 unit and e2e tests, on paste, upload, update, both job routes and the query/list filters).
- A tags-only update on a legacy document with no stored text must work, must not re-embed (its chunk ids stay), and `tags: null` must count as "not sent" (Task 1 tests).
- Another user's documents, tags and tag counts never appear in results, in `GET /documents/tags`, or in list filtering (Task 1 and 2 tests with two owners).
- Filters combine with AND with each other and with `documentIds`; a filter that matches nothing returns the existing "no passages" answer, not an error, in vector, keyword, hybrid and the SSE route (Task 2 tests).
- Date boundaries: `createdAfter` inclusive, `createdBefore` exclusive, a date-only value, an offset value, a malformed value is a `400`, and the outcome does not depend on the database's time zone (Task 2 tests).
- The approximate (HNSW) path with a filter must still return the filtered rows, via the existing exact fallback (Task 2 test with `EXACT_SEARCH_MAX_CHUNKS=0`).

---

## File Structure

- Create `apps/api/src/database/migrations/0003-document-tags.ts`; modify `migrations/index.ts`.
- Create `apps/api/src/documents/tags.ts` (`normalizeTags`, limits).
- Modify `apps/api/src/documents/documents.dto.ts`, `documents.service.ts`, `documents.controller.ts`.
- Modify `apps/api/src/jobs/jobs.controller.ts`, `jobs.service.ts`.
- Create `apps/api/src/query/document-filter.ts` (`DocumentFilter`, `documentFilterSql`, `toInstant`).
- Modify `apps/api/src/query/query.service.ts`, `query.controller.ts`.
- Create `apps/api/test/tags.spec.ts`, `apps/api/test/document-filter.spec.ts`; modify `apps/api/test/migrations-list.spec.ts`, `apps/api/test/api.e2e.spec.ts`, and any unit test that asserts the old `c.document_id = ANY` SQL.
- Modify `README.md`, `TODO.md`.

---

### Task 1: Tags on documents

**Files:**
- Create: `apps/api/src/database/migrations/0003-document-tags.ts`, `apps/api/src/documents/tags.ts`, `apps/api/test/tags.spec.ts`
- Modify: `migrations/index.ts`, `documents.dto.ts`, `documents.service.ts`, `documents.controller.ts`, `jobs.controller.ts`, `jobs.service.ts`
- Modify: `apps/api/test/migrations-list.spec.ts`, `apps/api/test/api.e2e.spec.ts`

**Interfaces:**
- Produces:
  - `MAX_TAGS = 20`, `MAX_TAG_LENGTH = 40`, `normalizeTags(input: unknown): string[]` (throws `BadRequestException`).
  - Schema: `documents.tags text[] NOT NULL DEFAULT '{}'`, index `documents_tags_idx` (GIN).
  - `DocumentSummary.tags: string[]`; `CreateDocumentDto.tags?: string[]`, `UpdateDocumentDto.tags?: string[]`.
  - `DocumentsService.ingestFile(filename, buffer, owner?, language?, tags?: unknown)`.
  - `DocumentsService.list(owner?, filter?: { tags?: string[]; source?: string })`, `DocumentsService.listTags(owner?): Promise<{ tag: string; count: number }[]>`.
  - Routes: `tags` on `POST /documents`, `POST /documents/upload` (text field), `PUT /documents/:id`, `POST /jobs/documents`, `POST /jobs/upload`; `GET /documents?tag=&source=`; `GET /documents/tags`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/tags.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from '../src/documents/tags';

describe('normalizeTags', () => {
  it('trims, lower-cases, collapses spaces, removes duplicates and sorts', () => {
    expect(normalizeTags(['  Billing ', 'PRICING', 'billing', 'Team   Plans'])).toEqual(['billing', 'pricing', 'team plans']);
  });

  it('splits on commas, in a single string and in every element', () => {
    expect(normalizeTags('b, a,,c')).toEqual(['a', 'b', 'c']);
    expect(normalizeTags(['b,a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('treats nothing as no tags', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags('')).toEqual([]);
    expect(normalizeTags([' ', ','])).toEqual([]);
  });

  it('accepts accents, other scripts and the punctuation people use in labels', () => {
    expect(normalizeTags(['Café', 'документ', 'c++', 'v1.2', 'team:billing', 'a/b', 'q&a'.replace('&', '-'), '#urgent'])).toEqual(
      ['#urgent', 'a/b', 'c++', 'café', 'q-a', 'team:billing', 'v1.2', 'документ'],
    );
  });

  it('rejects a tag that is too long, naming the limit, without echoing all of it', () => {
    const long = 'x'.repeat(MAX_TAG_LENGTH + 1);
    expect(() => normalizeTags([long])).toThrow(BadRequestException);
    expect(() => normalizeTags([long])).toThrow(new RegExp(String(MAX_TAG_LENGTH)));
    try {
      normalizeTags(['y'.repeat(5000)]);
    } catch (err) {
      expect(JSON.stringify((err as BadRequestException).getResponse()).length).toBeLessThan(300);
    }
  });

  it('rejects more than the maximum number of distinct tags, but not repeats of one', () => {
    const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
    expect(() => normalizeTags(many)).toThrow(new RegExp(String(MAX_TAGS)));
    expect(normalizeTags([...many.slice(0, MAX_TAGS), 't0', 'T0'])).toHaveLength(MAX_TAGS);
  });

  it('rejects characters outside the allowed set, and anything that is not text', () => {
    expect(() => normalizeTags(['<script>'])).toThrow(BadRequestException);
    expect(() => normalizeTags(['a;b'])).toThrow(BadRequestException);
    expect(() => normalizeTags(["it's"])).toThrow(BadRequestException);
    expect(() => normalizeTags(['_leading'])).toThrow(BadRequestException);
    expect(() => normalizeTags([1 as unknown as string])).toThrow(/text/);
    expect(() => normalizeTags({ a: 1 })).toThrow(/text/);
  });
});
```

In `migrations-list.spec.ts` add `expect(migrations[2]).toMatchObject({ id: 3, name: 'document_tags' });`.

In `api.e2e.spec.ts`, update the `'schema migrations on real schemas (e2e)'` and `'DatabaseService startup (e2e)'` blocks for three migrations:
- "builds the whole current schema": recorded rows become `[{1,'baseline'},{2,'document_language'},{3,'document_tags'}]`; `columns('documents')` also contains `tags`; the index list contains `documents_tags_idx`.
- "adopts a database from the first release": recorded ids `[{id:1},{id:2},{id:3}]`; the kept row also has `tags: []` (select `tags`).
- "adopts a database that already has the current schema but no tracking table": still starts from `migrations.slice(0, 1)`; the final run resolves to length **3**; recorded ids `[1, 2, 3]`.
- "migration 2 gives existing rows the english language...": run `migrations.slice(0, 2)` (not all) in the second `runMigrations` call, expecting `[2]`.
- DatabaseService "migrates on start": recorded ids `[1, 2, 3]`.
- Add:

```ts
  it('migration 3 gives existing documents no tags and indexes the column', async () => {
    await runMigrations(scratch.pool, migrations.slice(0, 2), ctx);
    const q = (sql: string, p: unknown[] = []) => scratch.pool.query(sql, p);
    await q("INSERT INTO documents (title, char_count) VALUES ('Old', 3)");

    expect((await runMigrations(scratch.pool, migrations, ctx)).map((m) => m.id)).toEqual([3]);

    expect((await q('SELECT tags FROM documents')).rows).toEqual([{ tags: [] }]);
    expect(await indexes()).toContain('documents_tags_idx');
    await q("UPDATE documents SET tags = '{a,b}'");
    expect((await q("SELECT count(*)::int AS n FROM documents WHERE tags && ARRAY['b']")).rows[0].n).toBe(1);
  });
```

Append a new block `describeIfDb('document tags (e2e)')` (boot copied from the `'document language (e2e)'` block, same env, plus nothing extra):

```ts
describeIfDb('document tags (e2e)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB, EMBEDDING_PROVIDER: 'mock', CHAT_PROVIDER: 'mock', EMBEDDING_DIM: '256',
      API_KEYS: '', DEMO_MODE: '', FTS_LANGUAGE: '', RATE_LIMIT_PER_MIN: '0', RATE_LIMIT_COSTLY_PER_MIN: '0',
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
  const upload = (path: string, fields: [string, string][], text: string, name: string) => {
    const form = new FormData();
    form.append('file', new Blob([text]), name);
    for (const [k, v] of fields) form.append(k, v);
    return fetch(`${base}${path}`, { method: 'POST', body: form });
  };
  const remove = (id: string) => fetch(`${base}/documents/${id}`, { method: 'DELETE' });
  const create = async (title: string, extra: Record<string, unknown> = {}) =>
    readJson(await json('POST', '/documents', { title, content: `${title} body text. Marker ${title}.`, ...extra }));
  const chunkIds = async (id: string) =>
    (await app.get(DatabaseService).query('SELECT id::text FROM chunks WHERE document_id = $1 ORDER BY id', [id])).rows.map((r: any) => r.id);
  const waitForJob = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const j = await readJson(await fetch(`${base}/jobs/${id}`));
      if (j.status === 'succeeded' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('job did not finish');
  };
  const ids: string[] = [];
  afterEach(async () => {
    await Promise.all(ids.splice(0).map(remove));
  });
  const made = async (title: string, extra: Record<string, unknown> = {}) => {
    const doc = await create(title, extra);
    ids.push(doc.id);
    return doc;
  };

  it('defaults to no tags, and reports them on create, get and list', async () => {
    const plain = await made('tags-plain');
    expect(plain.tags).toEqual([]);
    const tagged = await made('tags-tagged', { tags: ['  Billing ', 'PRICING', 'billing'] });
    expect(tagged.tags).toEqual(['billing', 'pricing']);
    expect((await readJson(await fetch(`${base}/documents/${tagged.id}`))).tags).toEqual(['billing', 'pricing']);
    expect((await readJson(await fetch(`${base}/documents`))).find((d: any) => d.id === tagged.id).tags).toEqual(['billing', 'pricing']);
  });

  it('answers 400, never 500, for bad tags on paste, upload, update and both job routes', async () => {
    const ok = await made('tags-ok');
    const tooMany = Array.from({ length: 21 }, (_, i) => `t${i}`);
    const bad = [['<script>'], ['x'.repeat(41)], tooMany, [1], 'not-an-array'] as unknown[];
    for (const tags of bad) {
      expect((await json('POST', '/documents', { title: 'x', content: 'text', tags })).status).toBe(400);
      expect((await json('PUT', `/documents/${ok.id}`, { tags })).status).toBe(400);
      expect((await json('POST', '/jobs/documents', { title: 'x', content: 'text', tags })).status).toBe(400);
    }
    for (const value of ['<script>', 'x'.repeat(41), tooMany.join(',')]) {
      expect((await upload('/documents/upload', [['tags', value]], 'text to index', 'x.txt')).status).toBe(400);
      expect((await upload('/jobs/upload', [['tags', value]], 'text to index', 'x.txt')).status).toBe(400);
    }
  });

  it('takes tags from a multipart upload as a comma-separated or a repeated field', async () => {
    const a = await readJson(await upload('/documents/upload', [['tags', 'Billing, pricing']], 'Alpha words here. Tags-marker-one.', 'a.txt'));
    const b = await readJson(await upload('/documents/upload', [['tags', 'faq'], ['tags', 'billing']], 'Beta words here. Tags-marker-two.', 'b.txt'));
    ids.push(a.id, b.id);
    expect(a.tags).toEqual(['billing', 'pricing']);
    expect(b.tags).toEqual(['billing', 'faq']);
  });

  it('replaces, clears and ignores null tags on update', async () => {
    const doc = await made('tags-update', { tags: ['one', 'two'] });
    expect((await readJson(await json('PUT', `/documents/${doc.id}`, { tags: ['Three'] }))).tags).toEqual(['three']);
    expect((await readJson(await json('PUT', `/documents/${doc.id}`, { tags: [] }))).tags).toEqual([]);
    await json('PUT', `/documents/${doc.id}`, { tags: ['keep'] });
    const res = await json('PUT', `/documents/${doc.id}`, { tags: null });
    expect(res.status).toBe(400); // null is "not sent", and nothing else was sent
    expect((await readJson(await fetch(`${base}/documents/${doc.id}`))).tags).toEqual(['keep']);
  });

  it('changes only the tags without re-embedding: same chunks, same text, works without stored text', async () => {
    const doc = await made('tags-meta', { tags: ['a'] });
    const before = await chunkIds(doc.id);
    const updated = await readJson(await json('PUT', `/documents/${doc.id}`, { tags: ['b'] }));
    expect(updated.tags).toEqual(['b']);
    expect(await chunkIds(doc.id)).toEqual(before);

    await app.get(DatabaseService).query('UPDATE documents SET content = NULL WHERE id = $1', [doc.id]); // a legacy document
    const legacy = await json('PUT', `/documents/${doc.id}`, { tags: ['c'] });
    expect(legacy.status).toBe(200);
    expect((await readJson(legacy)).tags).toEqual(['c']);
  });

  it('writes tags together with a re-index when the title changes too', async () => {
    const doc = await made('tags-with-title', { tags: ['a'] });
    const before = await chunkIds(doc.id);
    const updated = await readJson(await json('PUT', `/documents/${doc.id}`, { title: 'tags-with-title renamed', tags: ['z'] }));
    expect(updated).toMatchObject({ title: 'tags-with-title renamed', tags: ['z'] });
    expect(await chunkIds(doc.id)).not.toEqual(before);
    const reindexed = await readJson(await fetch(`${base}/documents/${doc.id}/reindex`, { method: 'POST' }));
    expect(reindexed.tags).toEqual(['z']);
  });

  it('returns the existing document, with its own tags, when the same text is sent again with other tags', async () => {
    const first = await made('tags-dup', { tags: ['first'] });
    const second = await json('POST', '/documents', { title: 'tags-dup', content: `tags-dup body text. Marker tags-dup.`, tags: ['second'] });
    expect(second.status).toBe(200);
    expect(await readJson(second)).toMatchObject({ id: first.id, duplicate: true, tags: ['first'] });
  });

  it('passes tags through both background routes', async () => {
    const text = await readJson(await json('POST', '/jobs/documents', { title: 'tags-job-text', content: 'Job text body. Tags-marker-job.', tags: ['Job', 'text'] }));
    expect((await waitForJob(text.id)).status).toBe('succeeded');
    const created = (await readJson(await fetch(`${base}/documents`))).find((d: any) => d.title === 'tags-job-text');
    ids.push(created.id);
    expect(created.tags).toEqual(['job', 'text']);

    const file = await readJson(await upload('/jobs/upload', [['tags', 'Job, file']], 'Job file body. Tags-marker-file.', 'tags-job.txt'));
    expect((await waitForJob(file.id)).status).toBe('succeeded');
    const createdFile = (await readJson(await fetch(`${base}/documents`))).find((d: any) => d.source === 'tags-job.txt');
    ids.push(createdFile.id);
    expect(createdFile.tags).toEqual(['file', 'job']);
  });

  it('filters the list by tag (any of) and by source, and lists the tags with counts', async () => {
    const a = await made('tags-list-a', { tags: ['billing'], source: 'list-a.md' });
    const b = await made('tags-list-b', { tags: ['pricing'], source: 'list-b.md' });
    const c = await made('tags-list-c', { source: 'list-b.md' });
    const list = async (qs: string) => (await readJson(await fetch(`${base}/documents${qs}`))).map((d: any) => d.id).filter((id: string) => [a.id, b.id, c.id].includes(id));

    expect((await list('?tag=billing')).sort()).toEqual([a.id]);
    expect((await list('?tag=billing&tag=pricing')).sort()).toEqual([a.id, b.id].sort());
    expect((await list('?tag=Billing,pricing')).sort()).toEqual([a.id, b.id].sort());
    expect((await list('?source=list-b.md')).sort()).toEqual([b.id, c.id].sort());
    expect(await list('?tag=pricing&source=list-a.md')).toEqual([]);
    expect((await fetch(`${base}/documents?tag=%3Cscript%3E`)).status).toBe(400);

    const tags = await readJson(await fetch(`${base}/documents/tags`));
    expect(tags).toEqual(expect.arrayContaining([{ tag: 'billing', count: expect.any(Number) }, { tag: 'pricing', count: expect.any(Number) }]));
  });

  it("does not list or count another user's tags or documents", async () => {
    const docs = app.get(DocumentsService);
    const bob = await docs.create({ title: 'tags-bob', content: 'Bob only text. Tags-marker-bob.', tags: ['bobs-secret'] }, 'bob');
    try {
      expect((await docs.listTags('alice')).map((t) => t.tag)).not.toContain('bobs-secret');
      expect((await docs.listTags('bob')).map((t) => t.tag)).toContain('bobs-secret');
      expect((await docs.list('alice', { tags: ['bobs-secret'] })).map((d) => d.id)).toEqual([]);
      expect((await docs.list('bob', { tags: ['bobs-secret'] })).map((d) => d.id)).toEqual([bob.id]);
    } finally {
      await docs.remove(bob.id, 'bob');
    }
  });
});
```

In the existing `'demo mode on the real routes (e2e)'` block add a test that `GET /documents/tags` answers `200` in demo mode (reads pass) while `PUT /documents/:id` with `{ tags: [] }` answers `403` (use that block's existing helpers and ids; read the block first).

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_tags NODE_OPTIONS=--experimental-vm-modules npx jest test/tags.spec.ts test/migrations-list.spec.ts test/api.e2e.spec.ts -t "normalizeTags|real migration list|schema migrations|DatabaseService startup|document tags|demo mode"`
Expected: FAIL (no `tags` module, no migration 3, no `tags` on responses).

- [ ] **Step 3: Implement**

`migrations/0003-document-tags.ts`:

```ts
import { Migration } from '../migrator';

/** Free-form labels on a document, for filtering questions. Existing documents have none. */
export const documentTags: Migration = {
  id: 3,
  name: 'document_tags',
  async up(client) {
    await client.query("ALTER TABLE documents ADD COLUMN tags text[] NOT NULL DEFAULT '{}'");
    await client.query('CREATE INDEX documents_tags_idx ON documents USING gin (tags)');
  },
};
```

Append it to `migrations/index.ts` (`[baseline, documentLanguage, documentTags]`).

`documents/tags.ts`:

```ts
import { BadRequestException } from '@nestjs/common';

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
const ALLOWED = /^[\p{L}\p{N}][\p{L}\p{N} _.:/+#-]*$/u;

/**
 * The one place tags are cleaned and checked. Accepts a string, an array, or nothing; commas always separate
 * tags. Returns the distinct tags, lower-cased and sorted, or throws a 400 that does not echo long input.
 */
export function normalizeTags(input: unknown): string[] {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : [input];
  const tags = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequestException('Tags must be text');
    for (const part of item.split(',')) {
      const tag = part.trim().replace(/\s+/g, ' ').toLowerCase();
      if (!tag) continue;
      if (tag.length > MAX_TAG_LENGTH) {
        throw new BadRequestException(`A tag can be at most ${MAX_TAG_LENGTH} characters ("${tag.slice(0, 20)}..." is longer)`);
      }
      if (!ALLOWED.test(tag)) {
        throw new BadRequestException(`Tag "${tag}" may only use letters, numbers, spaces and _ - . : / + #, and must start with a letter or number`);
      }
      tags.add(tag);
    }
  }
  if (tags.size > MAX_TAGS) throw new BadRequestException(`At most ${MAX_TAGS} tags per document`);
  return [...tags].sort();
}
```

`documents.dto.ts`: import `ArrayMaxSize, IsArray` and add to both DTOs

```ts
  /** Labels for filtering questions; lower-cased, at most MAX_TAGS. Update replaces the set ([] clears it). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TAGS)
  @IsString({ each: true })
  @MaxLength(MAX_TAG_LENGTH, { each: true })
  tags?: string[];
```

(import `MAX_TAGS, MAX_TAG_LENGTH` from `./tags`; `UpdateDocumentDto` allows `null` through `@IsOptional`). Add `tags: string[];` to `DocumentSummary`.

`documents.service.ts`:
- `DocumentRow` gets `tags: string[];` ; `SUMMARY_COLUMNS` gains `, tags`; `toSummary` gains `tags: r.tags ?? []`.
- `create`: `const tags = normalizeTags(dto.tags);` as the first line (before language); the documents `INSERT` gains `tags` (`$10`, parameter appended).
- `ingestFile(filename, buffer, owner, language?, tags?: unknown)`: `const normalized = normalizeTags(tags);` before extracting; pass `tags: normalized` into `create`.
- `rebuild(current, title, content, language = current.language, tags = current.tags)`: `UPDATE ... tags = $10` (parameter appended).
- `update`: the nothing-to-change check becomes `dto.title === undefined && dto.content === undefined && dto.language === undefined && dto.tags == null` (message: `'Send a new title, new content, a new language, new tags, or any of them'`); `const tags = dto.tags != null ? normalizeTags(dto.tags) : undefined;` right after the language line. After loading `current`: if `dto.title === undefined && dto.content === undefined && language === undefined` (only tags), run

```ts
      const { rows } = await this.db.query<DocumentRow>(
        `UPDATE documents SET tags = $3 WHERE id = $1 AND owner_id = $2 RETURNING ${SUMMARY_COLUMNS}`,
        [id, owner, tags],
      );
      if (!rows[0]) throw new NotFoundException(`Document ${id} not found`);
      return toSummary(rows[0]);
```

  else pass `tags` as the fifth argument to `rebuild`.
- `list(owner = DEFAULT_OWNER, filter: { tags?: string[]; source?: string } = {})`: build `WHERE owner_id = $1` plus `AND tags && $n::text[]` (when `filter.tags?.length`) and `AND source = $n` (when set), `ORDER BY created_at DESC`.
- `listTags(owner = DEFAULT_OWNER)`:

```ts
    const { rows } = await this.db.query<{ tag: string; count: number }>(
      `SELECT t AS tag, count(*)::int AS count FROM documents d, unnest(d.tags) AS t
        WHERE d.owner_id = $1 GROUP BY t ORDER BY count DESC, t`,
      [owner],
    );
    return rows;
```

`documents.controller.ts`:
- `list`: `@Query('tag') tag: unknown, @Query('source') source: unknown` → `this.documents.list(owner, { tags: normalizeTags(tag), source: typeof source === 'string' && source ? source : undefined })` (a non-string `source`, e.g. repeated, is a `BadRequestException('source must be one value')`).
- New `@Get('tags') listTags(@CurrentUser() owner: string)` declared **before** `@Get(':id')`.
- `upload`: add `@Body('tags') tags: unknown` and pass it as the fifth argument of `ingestFile`.

`jobs.controller.ts`: `indexText` payload `{ ...dto, language: ..., tags: normalizeTags(dto.tags) }`; `upload` takes `@Body('tags') tags: unknown` and puts `tags: normalizeTags(tags)` in its payload (both validated at enqueue). `jobs.service.ts`: the `ingest_file` case passes `job.payload?.tags` as the fifth argument.

- [ ] **Step 4: Run the Step 2 command, expect PASS; then the whole suite and typecheck**

Run: the Step 2 command, then `cd apps/api && npm run typecheck && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_tags npm test > $WS/suite.txt 2>&1; tail -8 $WS/suite.txt`
Expected: new and updated tests pass; whole suite green (existing unit tests that fake `DocumentRow`s may need `tags: []` in their fixtures: update fixtures, not code, and ledger it).

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "Add tags to documents: migration 3, validation, update, list filter and tag counts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Filtering questions

**Files:**
- Create: `apps/api/src/query/document-filter.ts`, `apps/api/test/document-filter.spec.ts`
- Modify: `apps/api/src/query/query.service.ts`, `apps/api/src/query/query.controller.ts`
- Modify: `apps/api/test/api.e2e.spec.ts` (new blocks); any unit test asserting the old `c.document_id = ANY` SQL.

**Interfaces:**
- Consumes: `documents.tags`, `normalizeTags` (Task 1).
- Produces:
  - `interface DocumentFilter { documentIds?: string[]; tags?: string[]; source?: string; createdAfter?: string; createdBefore?: string }` (dates are ISO instants).
  - `documentFilterSql(filter: DocumentFilter | undefined, alias: string, firstParam: number): { sql: string; params: unknown[] }` (`sql` is `''` or a run of ` AND ...` conditions on `alias`, numbered from `$firstParam`).
  - `toInstant(name: string, value: string): string` (ISO instant; `BadRequestException` naming `name` when unparseable).
  - `QueryService.ask / askWithPassages / askStream / retrieve` take a `DocumentFilter` where they took `documentIds?: string[]` (same position).
  - `QueryDto` gains `tags?`, `source?`, `createdAfter?`, `createdBefore?`.

- [ ] **Step 1: Write the failing tests**

`apps/api/test/document-filter.spec.ts`:

```ts
import { BadRequestException } from '@nestjs/common';
import { documentFilterSql, toInstant } from '../src/query/document-filter';

describe('documentFilterSql', () => {
  it('is empty without a filter', () => {
    expect(documentFilterSql(undefined, 'd', 4)).toEqual({ sql: '', params: [] });
    expect(documentFilterSql({}, 'd', 4)).toEqual({ sql: '', params: [] });
    expect(documentFilterSql({ documentIds: [], tags: [] }, 'd', 4)).toEqual({ sql: '', params: [] });
  });

  it('adds one numbered condition per filter, in a fixed order, starting at the given parameter', () => {
    const { sql, params } = documentFilterSql(
      { documentIds: ['id1'], tags: ['a'], source: 'x.md', createdAfter: '2026-01-01T00:00:00.000Z', createdBefore: '2026-02-01T00:00:00.000Z' },
      'd',
      4,
    );
    expect(sql).toBe(
      ' AND d.id = ANY($4::uuid[]) AND d.tags && $5::text[] AND d.source = $6' +
        ' AND d.created_at >= $7::timestamptz AND d.created_at < $8::timestamptz',
    );
    expect(params).toEqual([['id1'], ['a'], 'x.md', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
  });

  it('numbers from the first free parameter and skips the filters that are absent', () => {
    expect(documentFilterSql({ tags: ['a'] }, 'docs', 2)).toEqual({ sql: ' AND docs.tags && $2::text[]', params: [['a']] });
  });
});

describe('toInstant', () => {
  it('turns a date or a date-time into an ISO instant', () => {
    expect(toInstant('createdAfter', '2026-01-10')).toBe('2026-01-10T00:00:00.000Z');
    expect(toInstant('createdAfter', '2026-01-10T12:00:00+02:00')).toBe('2026-01-10T10:00:00.000Z');
    expect(toInstant('createdAfter', '2026-01-10T12:00:00Z')).toBe('2026-01-10T12:00:00.000Z');
  });

  it('answers 400 naming the field when the value is not a date', () => {
    expect(() => toInstant('createdBefore', 'yesterday')).toThrow(BadRequestException);
    expect(() => toInstant('createdBefore', 'yesterday')).toThrow(/createdBefore/);
  });
});
```

In `api.e2e.spec.ts` append two blocks that share a helper factory so one boots with the default (exact) search and one forces the approximate (HNSW) path with `EXACT_SEARCH_MAX_CHUNKS=0`. Write a function `filterSuite(title: string, env: Record<string, string>)` that calls `describeIfDb(title, () => { ... })` with this body, then call it twice:

```ts
function filterSuite(title: string, env: Record<string, string>) {
  describeIfDb(title, () => {
    let app: INestApplication;
    let base: string;

    beforeAll(async () => {
      Object.assign(process.env, {
        DATABASE_URL: DB, EMBEDDING_PROVIDER: 'mock', CHAT_PROVIDER: 'mock', EMBEDDING_DIM: '256',
        API_KEYS: '', DEMO_MODE: '', FTS_LANGUAGE: '', RATE_LIMIT_PER_MIN: '0', RATE_LIMIT_COSTLY_PER_MIN: '0',
        EXACT_SEARCH_MAX_CHUNKS: '', ...env,
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
      process.env.EXACT_SEARCH_MAX_CHUNKS = '';
      await app?.close();
    });

    const db = () => app.get(DatabaseService);
    const docs = () => app.get(DocumentsService);
    const created: { id: string; owner: string }[] = [];
    afterEach(async () => {
      await Promise.all(created.splice(0).map((d) => db().query('DELETE FROM documents WHERE id = $1', [d.id])));
    });
    /** Every document mentions "invoice" so an unfiltered question finds all of them. */
    const add = async (title: string, opts: { tags?: string[]; source?: string; date?: string; owner?: string } = {}) => {
      const owner = opts.owner ?? 'default';
      const doc = await docs().create({ title, content: `The invoice policy for ${title}. Filters-marker ${title}.`, tags: opts.tags, source: opts.source }, owner);
      created.push({ id: doc.id, owner });
      if (opts.date) await db().query('UPDATE documents SET created_at = $2 WHERE id = $1', [doc.id, opts.date]);
      return doc;
    };
    const titles = async (filter: DocumentFilter | undefined, owner = 'default') =>
      (await app.get(QueryService).retrieve('invoice policy', 10, filter, owner)).map((c) => c.title).sort();
    const vec = async (q: string) => toVector((await app.get<EmbeddingProvider>(EMBEDDING_PROVIDER).embed([q]))[0]);

    it('retrieves only documents with any of the given tags', async () => {
      await add('F-billing', { tags: ['billing'] });
      await add('F-pricing', { tags: ['pricing', 'extra'] });
      await add('F-untagged');
      expect(await titles(undefined)).toEqual(['F-billing', 'F-pricing', 'F-untagged']);
      expect(await titles({ tags: ['billing'] })).toEqual(['F-billing']);
      expect(await titles({ tags: ['billing', 'extra'] })).toEqual(['F-billing', 'F-pricing']);
      expect(await titles({ tags: ['nothing'] })).toEqual([]);
    });

    it('filters by source, exactly', async () => {
      await add('F-a', { source: 'f-a.md' });
      await add('F-b', { source: 'f-b.md' });
      expect(await titles({ source: 'f-a.md' })).toEqual(['F-a']);
      expect(await titles({ source: 'f-a' })).toEqual([]);
    });

    it('filters by date: after is inclusive, before is exclusive', async () => {
      await add('F-jan', { date: '2026-01-10T00:00:00Z' });
      await add('F-feb', { date: '2026-02-10T00:00:00Z' });
      await add('F-mar', { date: '2026-03-10T00:00:00Z' });
      expect(await titles({ createdAfter: '2026-02-10T00:00:00.000Z' })).toEqual(['F-feb', 'F-mar']);
      expect(await titles({ createdBefore: '2026-02-10T00:00:00.000Z' })).toEqual(['F-jan']);
      expect(await titles({ createdAfter: '2026-01-15T00:00:00.000Z', createdBefore: '2026-03-01T00:00:00.000Z' })).toEqual(['F-feb']);
    });

    it('combines every filter with AND, and with documentIds', async () => {
      const a = await add('F-both', { tags: ['billing'], source: 'f.md', date: '2026-02-10T00:00:00Z' });
      await add('F-tag-only', { tags: ['billing'], source: 'other.md', date: '2026-02-10T00:00:00Z' });
      await add('F-late', { tags: ['billing'], source: 'f.md', date: '2026-06-10T00:00:00Z' });
      const filter = { tags: ['billing'], source: 'f.md', createdBefore: '2026-03-01T00:00:00.000Z' };
      expect(await titles(filter)).toEqual(['F-both']);
      expect(await titles({ ...filter, documentIds: [a.id] })).toEqual(['F-both']);
      expect(await titles({ ...filter, documentIds: ['00000000-0000-0000-0000-000000000000'] })).toEqual([]);
    });

    it("never returns another user's documents, however the filter is set", async () => {
      await add('F-bob', { tags: ['shared-tag'], owner: 'bob' });
      await add('F-alice', { tags: ['shared-tag'], owner: 'alice' });
      expect(await titles({ tags: ['shared-tag'] }, 'alice')).toEqual(['F-alice']);
      expect(await titles({ tags: ['shared-tag'] }, 'bob')).toEqual(['F-bob']);
    });

    it('applies the filter to the vector search and to the keyword search alike', async () => {
      await add('F-billing', { tags: ['billing'] });
      await add('F-pricing', { tags: ['pricing'] });
      const query = app.get(QueryService) as any;
      const filter = { tags: ['billing'] };
      const v = await vec('invoice policy');
      expect((await query.vectorSearch(v, 10, 'default', filter)).map((r: any) => r.title)).toEqual(['F-billing']);
      expect((await query.lexicalSearch(v, 'invoice policy', 10, 'default', filter)).map((r: any) => r.title)).toEqual(['F-billing']);
      expect((await query.lexicalSearch(v, 'invoice policy', 10, 'default', { tags: ['none'] })).map((r: any) => r.title)).toEqual([]);
    });

    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('filters /query and /query/stream, and answers "no passages" when nothing matches', async () => {
      await add('F-billing', { tags: ['billing'] });
      await add('F-pricing', { tags: ['pricing'] });
      const hit = await readJson(await post('/query', { question: 'invoice policy', tags: ['Billing'] }));
      expect(hit.sources.map((s: any) => s.title)).toEqual(['F-billing']);

      const none = await post('/query', { question: 'invoice policy', tags: ['nothing'] });
      expect(none.status).toBe(200);
      const noneBody = await readJson(none);
      expect(noneBody.sources).toEqual([]);

      const stream = await post('/query/stream', { question: 'invoice policy', tags: ['nothing'] });
      expect(stream.status).toBe(200);
      const events = parseSse(await stream.text());
      expect(events.find((e) => e.event === 'sources')!.data.sources).toEqual([]);
      expect(events.at(-1)!.event).toBe('done');
    });

    it('answers 400 for bad filters, naming the field', async () => {
      for (const body of [
        { question: 'q', createdAfter: 'yesterday' },
        { question: 'q', createdBefore: 'not a date' },
        { question: 'q', tags: ['<script>'] },
        { question: 'q', tags: [1] },
        { question: 'q', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
        { question: 'q', source: 5 },
      ]) {
        expect((await post('/query', body)).status).toBe(400);
        expect((await post('/query/stream', body)).status).toBe(400);
      }
    });

    it('does not depend on the database time zone', async () => {
      await add('F-edge', { date: '2026-02-10T00:00:00Z' });
      await db().query("SET TIME ZONE 'Pacific/Auckland'");
      const rows = await titles({ createdAfter: '2026-02-10T00:00:00.000Z', createdBefore: '2026-02-10T00:00:01.000Z' });
      await db().query('RESET TIME ZONE');
      expect(rows).toEqual(['F-edge']);
    });
  });
}

filterSuite('metadata filters on the real routes (e2e)', {});
filterSuite('metadata filters on the approximate index path (e2e)', { EXACT_SEARCH_MAX_CHUNKS: '0' });
```

Notes for the executor: add `import { DocumentFilter } from '../src/query/document-filter';`; `DatabaseService`, `DocumentsService`, `QueryService`, `toVector`, `EMBEDDING_PROVIDER`, `EmbeddingProvider`, `parseSse`, `readJson` are already imported in the file. The last test's `SET TIME ZONE` applies to one pooled connection only; if the pool hands the next query to another connection the assertion is still meaningful (instants are sent, not strings), so keep it simple, or drop the `SET` and keep the boundary assertion if it proves flaky and ledger a ruling. Tests for a `date-only` value go through the controller (`toInstant`), covered by `document-filter.spec.ts` plus one `/query` call with `createdAfter: '2026-02-10'` in the "filters /query" test if convenient.

- [ ] **Step 2: Run, expect FAIL**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_tags NODE_OPTIONS=--experimental-vm-modules npx jest test/document-filter.spec.ts test/api.e2e.spec.ts -t "documentFilterSql|toInstant|metadata filters"`
Expected: FAIL (cannot find module `../src/query/document-filter`).

- [ ] **Step 3: Implement**

`query/document-filter.ts`:

```ts
import { BadRequestException } from '@nestjs/common';

/** What a question may be narrowed to. Every field is optional and they combine with AND. */
export interface DocumentFilter {
  /** Only these documents. */
  documentIds?: string[];
  /** Documents with any of these tags (already normalised). */
  tags?: string[];
  /** Exact match on the document's `source`. */
  source?: string;
  /** ISO instants: indexed at or after / strictly before. */
  createdAfter?: string;
  createdBefore?: string;
}

/**
 * The SQL for a filter, as ` AND ...` conditions on the `documents` table under `alias`, numbering its
 * parameters from `$firstParam`. Empty when there is nothing to filter on.
 */
export function documentFilterSql(
  filter: DocumentFilter | undefined,
  alias: string,
  firstParam: number,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (condition: (n: number) => string, value: unknown) => {
    params.push(value);
    parts.push(` AND ${condition(firstParam + params.length - 1)}`);
  };
  if (filter?.documentIds?.length) add((n) => `${alias}.id = ANY($${n}::uuid[])`, filter.documentIds);
  if (filter?.tags?.length) add((n) => `${alias}.tags && $${n}::text[]`, filter.tags);
  if (filter?.source) add((n) => `${alias}.source = $${n}`, filter.source);
  if (filter?.createdAfter) add((n) => `${alias}.created_at >= $${n}::timestamptz`, filter.createdAfter);
  if (filter?.createdBefore) add((n) => `${alias}.created_at < $${n}::timestamptz`, filter.createdBefore);
  return { sql: parts.join(''), params };
}

/** An ISO 8601 date or date-time as an instant, so the database's time zone never matters. */
export function toInstant(name: string, value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new BadRequestException(`${name} must be an ISO 8601 date or date-time`);
  return new Date(ms).toISOString();
}
```

`query.service.ts`: import `DocumentFilter, documentFilterSql`; in `vectorSearch`, `lexicalSearch`, `retrieve`, `ask`, `askWithPassages`, `askStream` rename the `documentIds?: string[]` parameter to `filter?: DocumentFilter` and pass it through. In `vectorSearch`:

```ts
    const scope = documentFilterSql(filter, 'd', 4);
    const params: unknown[] = [vector, limit, owner, ...scope.params];
    const filterSql = `WHERE d.owner_id = $3${scope.sql}`;
```

(replace the old `filter` string with `filterSql` in the SELECT). In `lexicalSearch` the language lookup becomes

```ts
    const scope = documentFilterSql(filter, 'd', 2);
    const { rows: languages } = await this.db.query<{ language: string }>(
      `SELECT DISTINCT d.language FROM documents d WHERE d.owner_id = $1${scope.sql}`,
      [owner, ...scope.params],
    );
```

and each per-language query uses `const inLanguage = documentFilterSql(filter, 'd', 6);`, params `[vector, limit, owner, tsquery, language, ...inLanguage.params]`, and `${inLanguage.sql}` in place of the old `${filter}` fragment.

`query.controller.ts`: extend `QueryDto`:

```ts
  /** Documents with any of these tags. */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_TAGS) @IsString({ each: true }) @MaxLength(MAX_TAG_LENGTH, { each: true })
  tags?: string[];

  /** Documents whose source is exactly this. */
  @IsOptional() @IsString() @MaxLength(200)
  source?: string;

  /** Indexed at or after / before this ISO 8601 date or date-time (send Z or an offset). */
  @IsOptional() @IsISO8601() createdAfter?: string;
  @IsOptional() @IsISO8601() createdBefore?: string;
```

and a helper

```ts
function filterOf(dto: QueryDto): DocumentFilter {
  return {
    documentIds: dto.documentIds,
    tags: dto.tags?.length ? normalizeTags(dto.tags) : undefined,
    source: dto.source,
    createdAfter: dto.createdAfter ? toInstant('createdAfter', dto.createdAfter) : undefined,
    createdBefore: dto.createdBefore ? toInstant('createdBefore', dto.createdBefore) : undefined,
  };
}
```

used in `ask` and `stream` in place of `dto.documentIds` (compute it before the SSE headers are written, so a `400` is still a normal JSON response).

Unit tests with fake databases (`vector-fallback.spec.ts`, `hybrid.spec.ts`, ...) that match on SQL text keep working for the no-filter case; fix any that asserted `c.document_id = ANY`, then ledger it.

- [ ] **Step 4: Run the Step 2 command, expect PASS; then the whole suite and typecheck**

Expected: filter unit tests pass; both e2e filter suites pass (exact and approximate paths); whole suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "Filter questions by tag, source and date, in vector and keyword search

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Documentation, and a real run

**Files:**
- Modify: `README.md`, `TODO.md`

**Interfaces:**
- Consumes: the routes and fields from Tasks 1 and 2.

- [ ] **Step 1: Check it end to end for real**

On a scratch database (`rag_tags_run`, mock providers, `EMBEDDING_DIM=64`, port 4300, built API): upload two files with `-F tags='billing, pricing'` and `-F tags=faq`; `GET /documents?tag=faq`; `GET /documents/tags`; `PUT` tags only; `POST /query` with `{"question":"...","tags":["faq"]}` returns only that document's source; with `"createdBefore":"2000-01-01"` returns no sources; `"createdAfter":"yesterday"` is a `400`.
Expected: as stated. Any deviation gets a `Ruling:` line.

- [ ] **Step 2: Documentation and TODO**

- `README.md`: in the API table add `tags?` to `POST /documents`, `PUT /documents/:id`, `POST /jobs/documents`, and the `tags` text field to the two upload rows; `tag` and `source` query parameters on `GET /documents`; a row for `GET /documents/tags`; `tags`, `source`, `createdAfter`, `createdBefore` on `POST /query` and `/query/stream`. Add a "Tags and filters" paragraph under "Retrieval details" covering: tag rules (lower-cased, comma separates, at most 20 of at most 40 characters, allowed characters), tags-only update does not re-embed, identical text returns the existing document with its own tags, `tags` filter matches any, filters combine with AND and with `documentIds`, `source` is exact, dates are when the document was indexed (not a date in its text), after inclusive and before exclusive, send `Z` or an offset because a bare date-time is read in the API server's time zone, a filter that matches nothing gives the usual "no passages" answer, the web app does not expose them yet.
- `TODO.md`: tick "Metadata filters and tags" and say what it became.

- [ ] **Step 3: Final suite, then commit**

Run: `cd apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_tags npm test > $WS/suite.txt 2>&1; tail -8 $WS/suite.txt`
Expected: all pass.

```bash
git add README.md TODO.md
git commit -m "Document tags and question filters

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
