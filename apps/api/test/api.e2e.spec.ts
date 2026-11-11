/**
 * End-to-end test against a real Postgres + pgvector, using the offline mock providers.
 * Runs when E2E_DATABASE_URL is set (CI provides one); skipped otherwise.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import { readdir, readFile } from 'fs/promises';
import { AddressInfo } from 'net';
import { join, resolve } from 'path';
import { Client, Pool } from 'pg';
import { APP_CONFIG, AppConfig } from '../src/config';
import { DatabaseService, toVector } from '../src/database/database.service';
import { Migration, runMigrations } from '../src/database/migrator';
import { migrations } from '../src/database/migrations';
import { titleFrom } from '../src/documents/documents.dto';
import { DocumentsService } from '../src/documents/documents.service';
import { evaluate, evaluateAnswers } from '../src/eval/evaluate';
import { Judge } from '../src/eval/judge';
import { JobsService } from '../src/jobs/jobs.service';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../src/providers/types';
import { QueryService } from '../src/query/query.service';
import { bullet, makeDocx, makePdf, para } from './helpers/office';

const DB = process.env.E2E_DATABASE_URL;
const readJson = async (res: Response): Promise<any> => res.json();
const describeIfDb = DB ? describe : describe.skip;

/** Parse a complete SSE body into `{ event, data }` frames. */
const parseSse = (body: string): { event: string; data: any }[] =>
  body
    .split('\n\n')
    .filter(Boolean)
    .map((frame) => {
      const lines = frame.split('\n');
      return {
        event: lines.find((l) => l.startsWith('event: '))!.slice(7),
        data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)),
      };
    });

/** Toggle sequential scans for every new connection to the test database. */
async function setPlanner(seqscan: 'off' | 'default'): Promise<void> {
  const client = new Client({ connectionString: DB });
  await client.connect();
  try {
    await client.query(
      `DO $$ BEGIN EXECUTE format('ALTER DATABASE %I ${seqscan === 'off' ? 'SET enable_seqscan = off' : 'RESET enable_seqscan'}', current_database()); END $$`,
    );
  } finally {
    await client.end();
  }
}

describeIfDb('API (e2e)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      EMBEDDING_PROVIDER: 'mock',
      CHAT_PROVIDER: 'mock',
      EMBEDDING_DIM: '256',
      // This suite makes hundreds of calls from one address; rate limiting has its own spec.
      RATE_LIMIT_PER_MIN: '0',
      RATE_LIMIT_COSTLY_PER_MIN: '0',
    });
    // Tables here are tiny, so Postgres would scan them sequentially and never exercise the HNSW index.
    // Discourage that for the app's connections so index behaviour (e.g. filtered search) is what we test.
    await setPlanner('off');
    // Import after env is set so config picks it up.
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    // Start clean: the test owns this database.
    await fetch(`${base}/documents`)
      .then(readJson)
      .then((docs: { id: string }[]) =>
        Promise.all(docs.map((d) => fetch(`${base}/documents/${d.id}`, { method: 'DELETE' }))),
      );
  });

  afterAll(async () => {
    await app?.close();
    await setPlanner('default');
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  /** Index /samples through the API; returns the document ids. */
  async function indexSamples(): Promise<string[]> {
    const samples = resolve(process.cwd(), '../../samples');
    const ids: string[] = [];
    for (const file of (await readdir(samples)).filter((f) => f.endsWith('.md'))) {
      const content = await readFile(join(samples, file), 'utf8');
      const title = content.match(/^#\s+(.+)$/m)![1];
      ids.push((await readJson(await post('/documents', { title, content }))).id);
    }
    return ids;
  }

  const loadDataset = async () => JSON.parse(await readFile(resolve(process.cwd(), 'eval/dataset.json'), 'utf8'));

  it('indexes a document, answers with a citation, and deletes it', async () => {
    const created = await post('/documents', {
      title: 'Office guide',
      content: '# Office guide\n\n## Parking\n\nVisitors park in bay C.\n\n## Lunch\n\nThe canteen opens at noon.',
    });
    expect(created.status).toBe(201);
    const doc = await readJson(created);
    expect(doc.chunkCount).toBe(2);

    const res = await post('/query', { question: 'Where do visitors park?' });
    expect(res.status).toBe(200);
    const result = await readJson(res);
    expect(result.sources[0].label).toBe('Office guide — Parking');
    expect(result.answer).toContain('bay C');
    expect(result.sources[0].cited).toBe(true);

    const del = await fetch(`${base}/documents/${doc.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const after = await readJson(await post('/query', { question: 'Where do visitors park?' }));
    expect(after.sources).toHaveLength(0);
    expect(after.answer).toMatch(/don't know/);
  });

  it('streams an answer over SSE: sources, then tokens, then a done event', async () => {
    const created = await readJson(
      await post('/documents', {
        title: 'Stream guide',
        content: '# Stream guide\n\n## Parking\n\nVisitors park in bay C.',
      }),
    );

    const res = await post('/query/stream', { question: 'Where do visitors park?' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const events = parseSse(await res.text());
    expect(events[0].event).toBe('sources');
    expect(events.filter((e) => e.event === 'token').length).toBeGreaterThan(1);
    const done = events[events.length - 1];
    expect(done.event).toBe('done');
    expect(done.data.result.answer).toContain('bay C');
    expect(done.data.result.sources[0].cited).toBe(true);
    expect(events.filter((e) => e.event === 'token').map((e) => e.data.text).join('').trim()).toBe(
      done.data.result.answer,
    );

    await fetch(`${base}/documents/${created.id}`, { method: 'DELETE' });
  });

  it('does not index the same content twice', async () => {
    const body = { title: 'Dup guide', content: '# Dup guide\n\nThe canteen opens at noon.' };
    const first = await post('/documents', body);
    expect(first.status).toBe(201);
    const original = await readJson(first);
    expect(original.duplicate).toBe(false);

    const again = await post('/documents', { ...body, title: 'Same text, new title' });
    expect(again.status).toBe(200);
    const copy = await readJson(again);
    expect(copy.duplicate).toBe(true);
    expect(copy.id).toBe(original.id);

    const docs = await readJson(await fetch(`${base}/documents`));
    expect(docs.filter((d: { id: string }) => d.id === original.id)).toHaveLength(1);
    await fetch(`${base}/documents/${original.id}`, { method: 'DELETE' });
  });

  it('reports the embedding model and a healthy index', async () => {
    const health = await readJson(await fetch(`${base}/health`));
    expect(health).toMatchObject({ status: 'ok', embeddingModel: 'mock/hashed-bow/256', mismatchedDocuments: 0 });
  });

  it('resolves a follow-up question using the conversation history', async () => {
    const doc = await readJson(
      await post('/documents', {
        title: 'Pricing',
        content: '# Pricing\n\n## Team plan\n\nThe Team plan costs 12 dollars per seat.\n\n## Support\n\nEmail support@acme.test for help.',
      }),
    );
    const history = [
      { role: 'user', content: 'What does the Team plan cost?' },
      { role: 'assistant', content: 'The Team plan costs 12 dollars per seat [1].' },
    ];

    const result = await readJson(await post('/query', { question: 'and per seat?', history }));

    expect(result.meta.rewrittenQuestion).toContain('Team plan');
    expect(result.sources[0].label).toBe('Pricing — Team plan');
    await fetch(`${base}/documents/${doc.id}`, { method: 'DELETE' });
  });

  it('rejects malformed history', async () => {
    const bad = await post('/query', { question: 'hi', history: [{ role: 'system', content: 'x' }] });
    expect(bad.status).toBe(400);
  });

  describe('updating and re-indexing documents', () => {
    const put = (id: string, body: unknown) =>
      fetch(`${base}/documents/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const create = async (title: string, content: string) => readJson(await post('/documents', { title, content }));
    const remove = (id: string) => fetch(`${base}/documents/${id}`, { method: 'DELETE' });
    const sql = async (statement: string, params: unknown[] = []) => {
      const client = new Client({ connectionString: DB });
      await client.connect();
      try {
        return await client.query(statement, params);
      } finally {
        await client.end();
      }
    };
    const ask = async (question: string) => readJson(await post('/query', { question }));

    it('returns a document with its stored text', async () => {
      const doc = await create('Notes', '# Notes\n\nThe canteen opens at noon.');
      const res = await fetch(`${base}/documents/${doc.id}`);
      expect(res.status).toBe(200);
      expect(await readJson(res)).toMatchObject({ id: doc.id, title: 'Notes', content: '# Notes\n\nThe canteen opens at noon.' });
      expect((await fetch(`${base}/documents/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
      await remove(doc.id);
    });

    it('replaces the indexed text when the content changes, keeping the document id', async () => {
      const doc = await create('Policy', '# Policy\n\n## Parking\n\nVisitors park in bay C.');
      expect((await ask('Where do visitors park?')).answer).toContain('bay C');

      const res = await put(doc.id, { content: '# Policy\n\n## Parking\n\nVisitors park in bay Z.\n\n## Lunch\n\nThe canteen opens at noon.' });

      expect(res.status).toBe(200);
      const updated = await readJson(res);
      expect(updated).toMatchObject({ id: doc.id, title: 'Policy', chunkCount: 2, duplicate: false });
      expect(updated.createdAt).toBe(doc.createdAt);
      const after = await ask('Where do visitors park?');
      expect(after.answer).toContain('bay Z');
      expect(after.answer).not.toContain('bay C');
      // The old text's hash is free again, so uploading it now creates a new document.
      const again = await create('Old text', '# Policy\n\n## Parking\n\nVisitors park in bay C.');
      expect(again.duplicate).toBe(false);
      await remove(doc.id);
      await remove(again.id);
    });

    it('re-embeds when only the title changes, since the title is part of what is embedded', async () => {
      const doc = await create('Old title', '# Old title\n\n## Parking\n\nVisitors park in bay C.');
      const res = await put(doc.id, { title: 'New title' });
      expect(res.status).toBe(200);
      const result = await ask('Where do visitors park?');
      expect(result.sources[0].title).toBe('New title');
      await remove(doc.id);
    });

    it('refuses an update that would duplicate another document, leaving both untouched', async () => {
      const a = await create('A', 'Alpha text about the first topic.');
      const b = await create('B', 'Bravo text about the second topic.');

      const res = await put(b.id, { content: 'Alpha text about the first topic.' });

      expect(res.status).toBe(409);
      expect((await readJson(res)).message).toContain('"A"');
      expect((await ask('Bravo second topic')).answer).toContain('Bravo');
      await remove(a.id);
      await remove(b.id);
    });

    it('validates update requests', async () => {
      const doc = await create('V', 'Some text to validate against.');
      expect((await put(doc.id, {})).status).toBe(400);
      expect((await put(doc.id, { title: '' })).status).toBe(400);
      expect((await put(doc.id, { content: '   ' })).status).toBe(400);
      expect((await put(doc.id, { nope: 1 })).status).toBe(400);
      expect((await put('00000000-0000-4000-8000-000000000000', { title: 'x' })).status).toBe(404);
      expect((await put('not-a-uuid', { title: 'x' })).status).toBe(400);
      await remove(doc.id);
    });

    it('re-indexes a document from its stored text with the current chunk settings', async () => {
      const cfg = app.get<AppConfig>(APP_CONFIG);
      const sections = Array.from({ length: 6 }, (_, i) => `Sentence number ${i} about parking rules and bays.`).join(' ');
      const doc = await create('Rules', sections);
      expect(doc.chunkCount).toBe(1);

      const { chunkSize, chunkOverlap } = cfg;
      Object.assign(cfg, { chunkSize: 80, chunkOverlap: 10 });
      try {
        const res = await fetch(`${base}/documents/${doc.id}/reindex`, { method: 'POST' });
        expect(res.status).toBe(200);
        expect((await readJson(res)).chunkCount).toBeGreaterThan(1);
      } finally {
        Object.assign(cfg, { chunkSize, chunkOverlap });
      }
      await remove(doc.id);
    });

    it('cannot re-index a document indexed before source text was stored', async () => {
      const doc = await create('Legacy', 'Text from before content was stored.');
      await sql('UPDATE documents SET content = NULL WHERE id = $1', [doc.id]);

      const res = await fetch(`${base}/documents/${doc.id}/reindex`, { method: 'POST' });

      expect(res.status).toBe(409);
      expect((await readJson(res)).message).toMatch(/upload it again|re-upload/i);
      expect((await put(doc.id, { title: 'Renamed' })).status).toBe(409); // nothing to re-embed from
      expect((await put(doc.id, { content: 'Fresh text supplied with the update.' })).status).toBe(200);
      await remove(doc.id);
    });

    it('repairs a mixed-model index: re-index everything, then indexing works again', async () => {
      const ok = await create('Current', 'Current model text about parking.');
      const stale = await create('Stale', 'Stale model text about lunch.');
      const legacy = await create('Legacy', 'Legacy text about holidays.');
      await sql("UPDATE documents SET embedding_model = 'openai/text-embedding-3-small/1536' WHERE id = $1", [stale.id]);
      await sql('UPDATE documents SET content = NULL WHERE id = $1', [legacy.id]);
      expect((await readJson(await fetch(`${base}/health`))).status).toBe('degraded');
      expect((await post('/documents', { title: 'Blocked', content: 'Blocked while models are mixed.' })).status).toBe(409);

      const res = await fetch(`${base}/documents/reindex`, { method: 'POST' });

      expect(res.status).toBe(200);
      const report = await readJson(res);
      expect(report.reindexed).toBe(2);
      expect(report.skipped).toEqual([{ id: legacy.id, title: 'Legacy', reason: expect.stringMatching(/stored/i) }]);
      expect((await readJson(await fetch(`${base}/health`))).mismatchedDocuments).toBe(0);
      const added = await post('/documents', { title: 'Allowed', content: 'Allowed once the index is consistent.' });
      expect(added.status).toBe(201);
      for (const id of [ok.id, stale.id, legacy.id, (await readJson(added)).id]) await remove(id);
    });
  });

  describe('background jobs', () => {
    const enqueue = (path: string, body: unknown) =>
      fetch(`${base}/jobs/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const getJob = async (id: string) => readJson(await fetch(`${base}/jobs/${id}`));
    const settled = async (id: string, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = await getJob(id);
        if (job.status === 'succeeded' || job.status === 'failed') return job;
        if (Date.now() > deadline) throw new Error(`job ${id} still ${job.status} after ${timeoutMs}ms`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const rm = (id: string) => fetch(`${base}/documents/${id}`, { method: 'DELETE' });
    const sql = async (statement: string, params: unknown[] = []) => {
      const client = new Client({ connectionString: DB });
      await client.connect();
      try {
        return await client.query(statement, params);
      } finally {
        await client.end();
      }
    };

    it('does not charge a queued job\u2019s model calls to the request that queued it', async () => {
      const { recordModelCall, runInRequestContext } = await import('../src/observability/request-context');
      const embeddings = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
      const original = embeddings.embed.bind(embeddings);
      embeddings.embed = async (texts) => {
        recordModelCall({ kind: 'embedding', provider: 'test', model: 'm', inputTokens: 1, outputTokens: 0, ms: 1 });
        return original(texts);
      };
      try {
        const ctx = { requestId: 'queued-from-this-request', calls: [] as any[] };
        const view = await runInRequestContext(ctx, () =>
          app.get(JobsService).enqueue('ingest_text', {
            title: 'Context check',
            payload: { title: 'Context check', content: '# Context check\n\nThe lift is on the left.' },
          }),
        );
        const job = await settled(view.id);
        expect(job.status).toBe('succeeded');
        expect(ctx.calls).toHaveLength(0); // the job's embedding call is not this request's
        await rm(job.result.id);
      } finally {
        embeddings.embed = original;
      }
    });

    it('indexes pasted text in the background and reports the result', async () => {
      const res = await enqueue('documents', { title: 'Queued', content: '# Queued\n\n## Parking\n\nVisitors park in bay C.' });

      expect(res.status).toBe(202);
      const accepted = await readJson(res);
      expect(accepted).toMatchObject({ kind: 'ingest_text', title: 'Queued' });
      expect(['queued', 'running', 'succeeded']).toContain(accepted.status);

      const job = await settled(accepted.id);
      expect(job.status).toBe('succeeded');
      expect(job.result).toMatchObject({ title: 'Queued', chunkCount: 1, duplicate: false });
      expect(job.finishedAt).toBeTruthy();
      expect((await readJson(await post('/query', { question: 'Where do visitors park?' }))).answer).toContain('bay C');
      await rm(job.result.id);
    });

    it('returns before the work is done', async () => {
      const embeddings = app.get<EmbeddingProvider>(EMBEDDING_PROVIDER);
      const original = embeddings.embed.bind(embeddings);
      embeddings.embed = async (texts) => {
        await new Promise((r) => setTimeout(r, 600));
        return original(texts);
      };
      try {
        const started = Date.now();
        const accepted = await readJson(await enqueue('documents', { title: 'Slow', content: 'Slow text that takes a while to embed.' }));
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(400);
        expect(['queued', 'running']).toContain(accepted.status);
        expect((await getJob(accepted.id)).result).toBeUndefined();

        const job = await settled(accepted.id);
        expect(job.status).toBe('succeeded');
        await rm(job.result.id);
      } finally {
        embeddings.embed = original;
      }
    });

    it('runs file uploads as jobs, including extraction', async () => {
      const docx = await makeDocx([para('Travel policy', 'Heading1'), para('Flights', 'Heading2'), para('Book economy.')].join(''));
      const form = new FormData();
      form.append('file', new Blob([docx]), 'travel.docx');

      const res = await fetch(`${base}/jobs/upload`, { method: 'POST', body: form });

      expect(res.status).toBe(202);
      const job = await settled((await readJson(res)).id);
      expect(job).toMatchObject({ kind: 'ingest_file', status: 'succeeded', title: 'travel.docx' });
      expect(job.result.title).toBe('Travel policy');
      await rm(job.result.id);
    });

    it('rejects an unsupported file type up front, but reports an unreadable file as a failed job', async () => {
      const bad = new FormData();
      bad.append('file', new Blob(['x']), 'sheet.xlsx');
      expect((await fetch(`${base}/jobs/upload`, { method: 'POST', body: bad })).status).toBe(400);

      const broken = new FormData();
      broken.append('file', new Blob(['definitely not a pdf']), 'broken.pdf');
      const res = await fetch(`${base}/jobs/upload`, { method: 'POST', body: broken });
      expect(res.status).toBe(202);
      const job = await settled((await readJson(res)).id);
      expect(job.status).toBe('failed');
      expect(job.error).toMatch(/PDF/);
      expect(job.result).toBeUndefined();
    });

    it('reports duplicates and validation errors through the job', async () => {
      const body = { title: 'Twice', content: 'The same text submitted twice in a row.' };
      const first = await settled((await readJson(await enqueue('documents', body))).id);
      const second = await settled((await readJson(await enqueue('documents', body))).id);

      expect(second.status).toBe('succeeded');
      expect(second.result).toMatchObject({ id: first.result.id, duplicate: true });

      const empty = await settled((await readJson(await enqueue('documents', { title: 'Blank', content: '   ' }))).id);
      expect(empty.status).toBe('failed');
      expect(empty.error).toMatch(/no text/i);
      await rm(first.result.id);
    });

    it('re-indexes everything as a job with progress', async () => {
      const a = (await readJson(await post('/documents', { title: 'A', content: 'First document text.' }))).id;
      const b = (await readJson(await post('/documents', { title: 'B', content: 'Second document text.' }))).id;

      const accepted = await readJson(await enqueue('reindex', {}));
      const job = await settled(accepted.id);

      expect(accepted.kind).toBe('reindex_all');
      expect(job.status).toBe('succeeded');
      expect(job.result).toMatchObject({ reindexed: 2, skipped: [], failed: [] });
      expect(job.progress).toEqual({ done: 2, total: 2 });
      await rm(a);
      await rm(b);
    });

    it('validates job lookups, lists recent jobs, and never exposes payloads', async () => {
      expect((await fetch(`${base}/jobs/not-a-uuid`)).status).toBe(400);
      expect((await fetch(`${base}/jobs/00000000-0000-4000-8000-000000000000`)).status).toBe(404);

      const job = await settled((await readJson(await enqueue('documents', { title: 'Listed', content: 'Listed job text.' }))).id);
      const list = await readJson(await fetch(`${base}/jobs`));
      expect(list.map((j: { id: string }) => j.id)).toContain(job.id);
      expect(JSON.stringify(list)).not.toContain('Listed job text.');
      await rm(job.result.id);
    });

    it('drops the stored payload once a job has finished', async () => {
      const job = await settled((await readJson(await enqueue('documents', { title: 'Payload', content: 'Payload text to be dropped.' }))).id);
      const { rows } = await sql('SELECT payload, file FROM ingestion_jobs WHERE id = $1', [job.id]);
      expect(rows[0]).toEqual({ payload: null, file: null });
      await rm(job.result.id);
    });

    it('marks jobs that were running when the server stopped as failed, and purges old finished ones', async () => {
      const jobs = app.get(JobsService);
      const { rows } = await sql(
        `INSERT INTO ingestion_jobs (kind, status, title, started_at) VALUES ('ingest_text', 'running', 'Interrupted', now())
         RETURNING id`,
      );
      await sql(
        `INSERT INTO ingestion_jobs (kind, status, title, finished_at, created_at)
         VALUES ('ingest_text', 'succeeded', 'Ancient', now() - interval '30 days', now() - interval '30 days')`,
      );

      await jobs.recoverInterrupted();
      await jobs.purgeOld();

      const interrupted = await getJob(rows[0].id);
      expect(interrupted.status).toBe('failed');
      expect(interrupted.error).toMatch(/restart/i);
      expect((await sql("SELECT 1 FROM ingestion_jobs WHERE title = 'Ancient'")).rowCount).toBe(0);
    });
  });

  const upload = (name: string, bytes: Buffer) => {
    const form = new FormData();
    form.append('file', new Blob([bytes]), name);
    return fetch(`${base}/documents/upload`, { method: 'POST', body: form });
  };

  it('indexes an uploaded Word document, keeping its headings as sections', async () => {
    const docx = await makeDocx(
      [para('Travel policy', 'Heading1'), para('Flights', 'Heading2'), para('Book economy for trips under six hours.'), bullet('Receipts within 30 days')].join(''),
    );

    const res = await upload('travel.docx', docx);

    expect(res.status).toBe(201);
    const doc = await readJson(res);
    expect(doc.title).toBe('Travel policy');
    const answer = await readJson(await post('/query', { question: 'Which class should I book for short trips?' }));
    expect(answer.sources[0].label).toBe('Travel policy — Flights');
    await fetch(`${base}/documents/${doc.id}`, { method: 'DELETE' });
  });

  it('indexes an uploaded PDF and answers from it', async () => {
    const pdf = makePdf([['Parking rules', 'Visitors park in bay C and register at reception.']]);

    const res = await upload('rules.pdf', pdf);

    expect(res.status).toBe(201);
    const doc = await readJson(res);
    expect(doc.title).toBe('rules');
    const answer = await readJson(await post('/query', { question: 'Where do visitors park?' }));
    expect(answer.answer).toContain('bay C');
    await fetch(`${base}/documents/${doc.id}`, { method: 'DELETE' });
  });

  it('answers 400 with a useful message for files it cannot read', async () => {
    const corrupt = await upload('broken.pdf', Buffer.from('definitely not a pdf'));
    expect(corrupt.status).toBe(400);
    expect((await readJson(corrupt)).message).toMatch(/PDF/);

    const unsupported = await upload('sheet.xlsx', Buffer.from('x'));
    expect(unsupported.status).toBe(400);
    expect((await readJson(unsupported)).message).toMatch(/\.pdf/);
  });

  it('rejects invalid stream requests before opening the stream', async () => {
    const res = await post('/query/stream', { question: '' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('rejects invalid input', async () => {
    expect((await post('/query', { question: '' })).status).toBe(400);
    expect((await post('/documents', { title: 'x' })).status).toBe(400);
  });

  it('still finds a filtered document when other documents rank much closer', async () => {
    // 60 sections of a big document all match the question better than the one passage we filter to.
    // The HNSW index returns only its 40 nearest candidates, all from the big document, and the
    // document filter then leaves nothing, unless search notices it came back short and scans exactly.
    const sections = Array.from({ length: 60 }, (_, i) => `## Part ${i}\n\nalpha beta gamma delta marker${i}`);
    const big = await readJson(await post('/documents', { title: 'Big', content: `# Big\n\n${sections.join('\n\n')}` }));
    const small = await readJson(
      await post('/documents', { title: 'Small', content: '# Small\n\n## Note\n\ngamma lonely passage' }),
    );

    const cfg = app.get<AppConfig>(APP_CONFIG);
    const { searchMode, exactSearchMaxChunks } = cfg;
    cfg.searchMode = 'vector'; // hybrid's full-text half would rescue the passage and hide the problem
    cfg.exactSearchMaxChunks = 0; // exact search would sidestep the index; this test is about the index path
    try {
      const result = await readJson(
        await post('/query', { question: 'alpha beta gamma delta', documentIds: [small.id], topK: 3 }),
      );
      expect(result.sources.map((s: { title: string }) => s.title)).toEqual(['Small']);

      const bigOnly = await readJson(
        await post('/query', { question: 'alpha beta gamma delta', documentIds: [big.id], topK: 5 }),
      );
      expect(bigOnly.sources).toHaveLength(5);
    } finally {
      Object.assign(cfg, { searchMode, exactSearchMaxChunks });
      await fetch(`${base}/documents/${big.id}`, { method: 'DELETE' });
      await fetch(`${base}/documents/${small.id}`, { method: 'DELETE' });
    }
  });

  it('keeps vector search complete while many deleted chunks are still in the index', async () => {
    // Deleting a document leaves its HNSW entries behind until VACUUM, and an index full of them returns
    // nothing live or a page of rows that are not the true nearest (random: it failed on CI, passed locally).
    // Corpora up to EXACT_SEARCH_MAX_CHUNKS therefore bypass the index, which this test relies on.
    const client = new Client({ connectionString: DB });
    await client.connect();
    const cfg = app.get<AppConfig>(APP_CONFIG);
    const mode = cfg.searchMode;
    cfg.searchMode = 'vector'; // hybrid's full-text half would rescue the passage and hide the problem
    const ids: string[] = [];
    try {
      await client.query('ALTER TABLE chunks SET (autovacuum_enabled = false)');
      for (let round = 0; round < 3; round++) {
        await client.query(
          `WITH d AS (INSERT INTO documents (title, source, char_count, chunk_count) VALUES ('churn', 'x', 1, 1000) RETURNING id),
                c AS (INSERT INTO chunks (document_id, ordinal, heading, content, embedding)
                      SELECT d.id, g, 'h', 'c', (SELECT array_agg(random() - 0.5) FROM generate_series(1, 256))::vector
                        FROM d, generate_series(1, 1000) g)
           DELETE FROM documents WHERE id = (SELECT id FROM d) AND false`,
        );
        await client.query("DELETE FROM documents WHERE title = 'churn'");
      }
      ids.push(...(await indexSamples()));

      const query = app.get(QueryService);
      const report = await evaluate((question, k) => query.retrieve(question, k), await loadDataset(), 5);

      // A clean index scores 100%; with ~3000 dead entries and a plain index scan this fell to about 2/3.
      expect(report.hitRate).toBeGreaterThanOrEqual(0.95);
    } finally {
      cfg.searchMode = mode;
      await Promise.all(ids.map((id) => fetch(`${base}/documents/${id}`, { method: 'DELETE' })));
      await client.query('ALTER TABLE chunks RESET (autovacuum_enabled)');
      await client.query('VACUUM chunks'); // leave a clean index for the tests that follow
      await client.end();
    }
  });

  // Guards retrieval quality on the sample docs (offline mock embeddings, so the bar is modest).
  // Baselines on the 24-question set: vector hit@1 95.2% / MRR 0.976; hybrid (default) hit@1 100% / MRR 1.0;
  // abstain 33% for both (mock hash collisions).
  // Raise these when retrieval improves; if a change makes them fail, it made search worse.
  it('keeps retrieval quality on the eval set above the baseline', async () => {
    const ids = await indexSamples();
    const dataset = await loadDataset();
    const query = app.get(QueryService);

    const report = await evaluate((question, k) => query.retrieve(question, k), dataset, 5);

    await Promise.all(ids.map((id) => fetch(`${base}/documents/${id}`, { method: 'DELETE' })));
    if (report.top1Rate < 0.95) console.log('misranked:', JSON.stringify(report.misranked, null, 1));
    expect(report.hitRate).toBeGreaterThanOrEqual(0.95);
    expect(report.top1Rate).toBeGreaterThanOrEqual(0.95);
    expect(report.mrr).toBeGreaterThanOrEqual(0.98);
    expect(report.abstainRate).toBeGreaterThanOrEqual(0.3);
  });

  // The mock chat provider echoes the top passage with a [1] citation, so groundedness can't be judged
  // offline (a stub judge stands in, and real judging is covered by the unit tests and `npm run eval -- --answers`).
  // This guards the deterministic half: refuse when nothing relevant was retrieved, and cite when answering.
  // (wrongRefusals and unjudged are not asserted: with the mock and a stub judge they cannot be anything but 0.)
  it('keeps the deterministic answer metrics above the baseline', async () => {
    const ids = await indexSamples();
    const dataset = await loadDataset();
    const query = app.get(QueryService);
    const everythingSupported: Judge = {
      judge: async (_question, answer) => ({ claims: [{ claim: answer, supported: true }] }),
    };

    const report = await evaluateAnswers((question) => query.askWithPassages(question), everythingSupported, dataset);

    await Promise.all(ids.map((id) => fetch(`${base}/documents/${id}`, { method: 'DELETE' })));
    if (report.failures.length) console.log('answer failures:', JSON.stringify(report.failures, null, 1));
    // The mock refuses exactly when retrieval returns nothing, so this tracks the abstain baseline (33%).
    expect(report.refusalRate).toBeGreaterThanOrEqual(0.3);
    expect(report.citationRate).toBe(1);
  });

});

describeIfDb('authentication and per-user isolation (e2e)', () => {
  const ALICE = 'alice-key-0123456789';
  const ALICE_2 = 'alice-second-key-0123';
  const BOB = 'bobs-key-abcdefghijk';
  const LEGACY = 'legacy-key-zyxwvutsrq';
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      EMBEDDING_PROVIDER: 'mock',
      CHAT_PROVIDER: 'mock',
      EMBEDDING_DIM: '256',
      API_KEYS: `${ALICE}:alice,${ALICE_2}:alice,${BOB}:bob,${LEGACY}:default`,
    });
    const { AppModule } = await import('../src/app.module');
    app = await NestFactory.create(AppModule, { logger: false });
    delete process.env.API_KEYS; // loaded already; don't leak into other suites
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    for (const key of [ALICE, BOB, LEGACY]) {
      const docs = await as(key, 'GET', '/documents').then(readJson);
      await Promise.all(docs.map((d: { id: string }) => as(key, 'DELETE', `/documents/${d.id}`)));
    }
    await app?.close();
  });

  const as = (key: string | undefined, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  const mine = async (key: string, title: string, content: string) =>
    readJson(await as(key, 'POST', '/documents', { title, content }));
  const ask = async (key: string, question: string, extra: object = {}) =>
    readJson(await as(key, 'POST', '/query', { question, ...extra }));
  const settled = async (key: string, id: string) => {
    for (let i = 0; i < 200; i++) {
      const job = await readJson(await as(key, 'GET', `/jobs/${id}`));
      if (job.status === 'succeeded' || job.status === 'failed') return job;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('job did not finish');
  };

  it('keeps health open, reports that a key is needed, and rejects everything else without one', async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await readJson(health)).toMatchObject({ authRequired: true });

    for (const [method, path] of [['GET', '/documents'], ['POST', '/query'], ['GET', '/jobs']]) {
      expect((await as(undefined, method, path, method === 'POST' ? { question: 'x' } : undefined)).status).toBe(401);
      expect((await as('wrong-key-wrong-key-1', method, path, method === 'POST' ? { question: 'x' } : undefined)).status).toBe(401);
    }
    expect((await as(undefined, 'POST', '/query/stream', { question: 'x' })).status).toBe(401);
  });

  it('accepts the key as X-API-Key and lets one user hold several keys', async () => {
    const viaHeader = await fetch(`${base}/documents`, { headers: { 'x-api-key': ALICE } });
    expect(viaHeader.status).toBe(200);

    const doc = await mine(ALICE, 'Shared by keys', 'Text visible through both of Alice\'s keys.');
    const second = await readJson(await as(ALICE_2, 'GET', '/documents'));
    expect(second.map((d: { id: string }) => d.id)).toContain(doc.id);
  });

  it('shows each user only their own documents on every route', async () => {
    const secret = await mine(ALICE, 'Alice private', '# Alice private\n\n## Safe\n\nThe vault code is zebra-4471.');

    expect((await readJson(await as(BOB, 'GET', '/documents'))).map((d: { id: string }) => d.id)).not.toContain(secret.id);
    expect((await as(BOB, 'GET', `/documents/${secret.id}`)).status).toBe(404);
    expect((await as(BOB, 'PUT', `/documents/${secret.id}`, { title: 'Hijacked' })).status).toBe(404);
    expect((await as(BOB, 'POST', `/documents/${secret.id}/reindex`)).status).toBe(404);
    expect((await as(BOB, 'DELETE', `/documents/${secret.id}`)).status).toBe(404);

    const intact = await readJson(await as(ALICE, 'GET', `/documents/${secret.id}`));
    expect(intact.title).toBe('Alice private');
  });

  it('never retrieves another user\'s passages, with or without naming their document id', async () => {
    const secret = await mine(ALICE, 'Alice vault', '# Alice vault\n\n## Code\n\nThe vault code is zebra-4471.');

    const alice = await ask(ALICE, 'What is the vault code?');
    expect(alice.answer).toContain('zebra-4471');

    for (const extra of [{}, { documentIds: [secret.id] }]) {
      const bob = await ask(BOB, 'What is the vault code?', extra);
      expect(bob.sources).toHaveLength(0);
      expect(bob.answer).toMatch(/don't know/);
      expect(JSON.stringify(bob)).not.toContain('zebra');
    }

    const stream = await as(BOB, 'POST', '/query/stream', { question: 'What is the vault code?', documentIds: [secret.id] });
    expect(await stream.text()).not.toContain('zebra');
  });

  it('treats identical text from two users as two documents, never handing one the other\'s', async () => {
    const text = 'Both users happen to upload exactly this paragraph.';
    const a = await mine(ALICE, 'Alice copy', text);
    const b = await mine(BOB, 'Bob copy', text);

    expect(b.duplicate).toBe(false);
    expect(b.id).not.toBe(a.id);
    expect(b.title).toBe('Bob copy'); // not Alice's title
    expect((await mine(ALICE, 'Alice again', text)).duplicate).toBe(true); // within one user, dedupe still works

    expect((await as(BOB, 'DELETE', `/documents/${b.id}`)).status).toBe(204);
    expect((await as(ALICE, 'GET', `/documents/${a.id}`)).status).toBe(200);
  });

  it('scopes background jobs to their owner', async () => {
    const res = await as(ALICE, 'POST', '/jobs/documents', { title: 'Alice job', content: 'Content of a job that only Alice may see.' });
    expect(res.status).toBe(202);
    const job = await settled(ALICE, (await readJson(res)).id);

    expect((await as(BOB, 'GET', `/jobs/${job.id}`)).status).toBe(404);
    expect((await readJson(await as(BOB, 'GET', '/jobs'))).map((j: { id: string }) => j.id)).not.toContain(job.id);
    expect((await readJson(await as(ALICE, 'GET', '/jobs'))).map((j: { id: string }) => j.id)).toContain(job.id);
    // The document the job created belongs to Alice too.
    expect((await as(BOB, 'GET', `/documents/${job.result.id}`)).status).toBe(404);
  });

  it('re-indexes only the caller\'s own documents', async () => {
    const before = (await readJson(await as(BOB, 'GET', '/documents'))).length;
    await mine(ALICE, 'Alice extra', 'Another document owned by Alice for the re-index test.');
    await mine(BOB, 'Bob extra', 'Another document owned by Bob for the re-index test.');

    const report = await readJson(await as(BOB, 'POST', '/documents/reindex'));

    expect(report.reindexed).toBe(before + 1);
  });

  it('gives documents from before accounts to the default user, reachable by mapping a key to it', async () => {
    const legacy = await mine(LEGACY, 'Pre-auth document', 'A document created before any accounts existed.');

    expect((await readJson(await as(ALICE, 'GET', '/documents'))).map((d: { id: string }) => d.id)).not.toContain(legacy.id);
    expect((await readJson(await as(LEGACY, 'GET', '/documents'))).map((d: { id: string }) => d.id)).toContain(legacy.id);
  });
});

/**
 * The real app and real routes with a tiny costly limit. It lives in this file, not its own, on purpose:
 * Jest runs spec files in parallel workers, and two apps migrating the same database at once race on
 * CREATE ... IF NOT EXISTS ("duplicate key value violates unique constraint pg_class_relname_nsp_index").
 */
describeIfDb('rate limiting on the real routes (e2e)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      EMBEDDING_PROVIDER: 'mock',
      CHAT_PROVIDER: 'mock',
      EMBEDDING_DIM: '256',
      API_KEYS: '',
      RATE_LIMIT_PER_MIN: '0',
      RATE_LIMIT_COSTLY_PER_MIN: '3',
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

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('shares the costly budget across query, stream, documents and jobs, and answers 429 as JSON before any SSE', async () => {
    expect((await post('/query', { question: 'anything?' })).status).toBe(200);
    expect((await post('/query', { question: 'anything?' })).status).toBe(200);
    expect((await post('/query/stream', { question: 'anything?' })).status).toBe(200);

    const query = await post('/query', { question: 'anything?' });
    expect(query.status).toBe(429);
    expect(Number(query.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    const stream = await post('/query/stream', { question: 'anything?' });
    expect(stream.status).toBe(429);
    expect(stream.headers.get('content-type')).toMatch(/application\/json/);
    expect(stream.headers.get('content-type')).not.toMatch(/event-stream/);

    expect((await post('/documents', { title: 'T', content: 'Some text to index.' })).status).toBe(429);
    expect((await post('/jobs/documents', { title: 'T', content: 'Some text to index.' })).status).toBe(429);
  });

  it('keeps cheap routes and /health open while the costly budget is spent', async () => {
    expect((await fetch(`${base}/documents`)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

/**
 * Demo mode on the real app: the samples seed themselves, questions work, every write is refused, and the
 * daily cap holds. In this file for the same reason as the rate-limit block: one worker per database.
 */
describeIfDb('demo mode on the real routes (e2e)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      EMBEDDING_PROVIDER: 'mock',
      CHAT_PROVIDER: 'mock',
      EMBEDDING_DIM: '256',
      API_KEYS: '',
      RATE_LIMIT_PER_MIN: '0',
      RATE_LIMIT_COSTLY_PER_MIN: '0',
      DEMO_MODE: 'true',
      DEMO_MAX_QUERIES_PER_DAY: '4',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/app.setup');
    const nest = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApp(nest, nest.get(APP_CONFIG));
    await nest.listen(0);
    app = nest;
    base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    // Writes are refused over HTTP in demo mode, so clean up through the service.
    const documents = app.get(DocumentsService);
    for (const doc of await documents.list()) await documents.remove(doc.id, 'default');
    await app?.close();
    delete process.env.DEMO_MODE;
    delete process.env.DEMO_MAX_QUERIES_PER_DAY;
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('has indexed the sample documents by the time it answers, with no seed step', async () => {
    const samples = resolve(process.cwd(), '../../samples');
    const expected: string[] = [];
    for (const file of (await readdir(samples)).filter((f) => f.endsWith('.md'))) {
      expected.push(titleFrom(await readFile(join(samples, file), 'utf8'), file.slice(0, -3)));
    }

    const titles = ((await readJson(await send('GET', '/documents'))) as { title: string }[]).map((d) => d.title);

    expect(expected.length).toBeGreaterThanOrEqual(2);
    for (const title of expected) expect(titles).toContain(title);
  });

  it('reports demo mode in /health', async () => {
    expect(await readJson(await send('GET', '/health'))).toMatchObject({ demo: true });
  });

  it('answers a question from the samples, with a citation', async () => {
    const res = await send('POST', '/query', { question: 'Can I deploy on Fridays?' });

    expect(res.status).toBe(200);
    const result = await readJson(res);
    expect(result.sources.length).toBeGreaterThan(0);
  });

  it('refuses every write with 403 and leaves the documents as they were', async () => {
    const before = ((await readJson(await send('GET', '/documents'))) as { id: string }[]).map((d) => d.id).sort();
    const id = before[0];

    const attempts = [
      send('POST', '/documents', { title: 'Mine', content: 'Visitor text.' }),
      send('PUT', `/documents/${id}`, { title: 'Hijacked' }),
      send('DELETE', `/documents/${id}`),
      send('POST', '/documents/reindex'),
      send('POST', `/documents/${id}/reindex`),
      send('POST', '/jobs/documents', { title: 'Mine', content: 'Visitor text.' }),
      send('POST', '/jobs/reindex'),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);

    const after = ((await readJson(await send('GET', '/documents'))) as { id: string }[]).map((d) => d.id).sort();
    expect(after).toEqual(before);
  });

  it('stops answering once the daily cap is used up, and says so', async () => {
    // One question was spent above; the cap is 4.
    for (let i = 0; i < 3; i++) expect((await send('POST', '/query', { question: 'What does the Team plan cost?' })).status).toBe(200);

    const res = await send('POST', '/query', { question: 'What does the Team plan cost?' });

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await send('POST', '/query/stream', { question: 'x' })).status).toBe(429);
    expect((await send('GET', '/documents')).status).toBe(200); // reads are not questions
  });
});

/**
 * Request ids on the real routes. In this file for the same reason as the blocks above: one worker per database.
 */
describeIfDb('request ids on the real routes (e2e)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    Object.assign(process.env, {
      DATABASE_URL: DB,
      EMBEDDING_PROVIDER: 'mock',
      CHAT_PROVIDER: 'mock',
      EMBEDDING_DIM: '256',
      API_KEYS: '',
      DEMO_MODE: '',
      RATE_LIMIT_PER_MIN: '0',
      RATE_LIMIT_COSTLY_PER_MIN: '0',
      LOG_FORMAT: 'json',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/app.setup');
    const { APP_CONFIG } = await import('../src/config');
    const nest = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    // Collect the access lines instead of printing them.
    (globalThis as { __accessLines?: string[] }).__accessLines = [];
    configureApp(nest, nest.get(APP_CONFIG), (line) => (globalThis as any).__accessLines.push(line));
    await nest.listen(0);
    app = nest;
    base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    delete process.env.LOG_FORMAT;
    await app?.close();
  });

  it('gives a normal response an X-Request-Id, and lets a browser page read it', async () => {
    const res = await fetch(`${base}/documents`, { headers: { origin: 'http://localhost:3000' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Request-Id');
  });

  it('puts the same id on the SSE stream, whose headers the controller writes itself, and on a 404', async () => {
    const stream = await fetch(`${base}/query/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'my-trace-id-0001' },
      body: JSON.stringify({ question: 'anything?' }),
    });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(stream.headers.get('x-request-id')).toBe('my-trace-id-0001');
    await stream.text();

    const missing = await fetch(`${base}/no-such-route`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes one access line for the stream with its route pattern and the id the client sent', async () => {
    const lines: string[] = (globalThis as any).__accessLines;
    for (let i = 0; i < 100 && !lines.some((l) => l.includes('my-trace-id-0001')); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const line = JSON.parse(lines.find((l) => l.includes('my-trace-id-0001'))!);
    expect(line).toMatchObject({ context: 'http', route: '/query/stream', status: 200, requestId: 'my-trace-id-0001' });
    expect(line.query).toMatchObject({ retrieved: expect.any(Number), retrieveMs: expect.any(Number) });
  });
});

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
    expect((await scratch.pool.query('SELECT id, name FROM schema_migrations ORDER BY id')).rows).toEqual([
      { id: 1, name: 'baseline' },
      { id: 2, name: 'document_language' },
    ]);
    expect(await columns('documents')).toContain('language');
    expect(await columns('chunks')).toContain('language');
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

    const kept = await q('SELECT title, owner_id, content_hash, content, language FROM documents');
    expect(kept.rows).toEqual([{ title: 'Old', owner_id: 'default', content_hash: null, content: null, language: 'english' }]);
    const chunk = await q("SELECT count(*)::int AS n FROM chunks WHERE fts @@ plainto_tsquery('english', 'words')");
    expect(chunk.rows[0].n).toBe(1);
    expect((await q('SELECT id FROM schema_migrations ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

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

  it('adopts a database that already has the current schema but no tracking table', async () => {
    await runMigrations(scratch.pool, migrations.slice(0, 1), ctx); // the schema as it was before migration 2
    await scratch.pool.query("INSERT INTO documents (title, char_count, content_hash) VALUES ('Kept', 5, 'h1')");
    await scratch.pool.query('DROP TABLE schema_migrations'); // what a database from before versioned migrations looks like

    await expect(runMigrations(scratch.pool, migrations, ctx)).resolves.toHaveLength(2);

    expect((await scratch.pool.query('SELECT title FROM documents')).rows).toEqual([{ title: 'Kept' }]);
    expect((await scratch.pool.query('SELECT id FROM schema_migrations ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
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
  const service = (embeddingDim: number, ftsLanguage = 'english') => {
    const url = new URL(DB!);
    url.searchParams.set('options', `-c search_path=${scratch.schema},public`);
    return new DatabaseService({ databaseUrl: url.toString(), embeddingDim, ftsLanguage } as AppConfig);
  };

  it('migrates on start and starts again without error', async () => {
    const first = service(8);
    await first.onModuleInit();
    await first.onModuleDestroy();
    const second = service(8);
    await second.onModuleInit();
    expect((await second.query('SELECT id FROM schema_migrations ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }]);
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

  it('lists the text search configurations, and refuses an unknown FTS_LANGUAGE naming the choices', async () => {
    const ok = service(8);
    await ok.onModuleInit();
    expect([...ok.textSearchConfigs]).toEqual(expect.arrayContaining(['english', 'german', 'simple']));
    await ok.onModuleDestroy();

    const bad = service(8, 'klingon');
    await expect(bad.onModuleInit()).rejects.toThrow(/FTS_LANGUAGE=klingon.*english.*german/s);
    await bad.onModuleDestroy();
  });
});

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
  const upload = (path: string, language: string | undefined, text: string, name: string) => {
    const form = new FormData();
    form.append('file', new Blob([text]), name);
    if (language !== undefined) form.append('language', language);
    return fetch(`${base}${path}`, { method: 'POST', body: form });
  };
  const remove = (id: string) => fetch(`${base}/documents/${id}`, { method: 'DELETE' });
  const languagesOf = async (id: string) =>
    (await app.get(DatabaseService).query('SELECT language::text AS l FROM chunks WHERE document_id = $1', [id])).rows.map((r: any) => r.l);
  const waitForJob = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const j = await readJson(await fetch(`${base}/jobs/${id}`));
      if (j.status === 'succeeded' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('job did not finish');
  };

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
      await upload('/documents/upload', 'klingon', 'text to index', 'x.txt'),
      await json('PUT', `/documents/${ok.id}`, { language: 'klingon' }),
      await json('POST', '/jobs/documents', { title: 'x', content: 'text', language: 'klingon' }),
      await upload('/jobs/upload', 'klingon', 'text to index', 'x.txt'),
    ]) {
      expect(res.status).toBe(400);
      expect(JSON.stringify(await readJson(res))).toMatch(/english.*german/s);
    }
    await remove(ok.id);
  });

  it('takes the language from a multipart upload field', async () => {
    const res = await upload('/documents/upload', 'french', 'Les factures sont payées chaque année. Unique-marker-four.', 'factures.txt');
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
    expect(await readJson(second)).toMatchObject({ id: first.id, duplicate: true, language: 'english' });
    await remove(first.id);
  });

  it('passes the language through the background job routes', async () => {
    const text = await readJson(await json('POST', '/jobs/documents', { title: 'Job de', content: `${GERMAN} Unique-marker-eight.`, language: 'german' }));
    expect((await waitForJob(text.id)).status).toBe('succeeded');
    const created = (await readJson(await fetch(`${base}/documents`))).find((d: any) => d.title === 'Job de');
    expect(created.language).toBe('german');
    await remove(created.id);

    const file = await readJson(await upload('/jobs/upload', 'french', 'Les factures sont payées. Unique-marker-nine.', 'job-fr.txt'));
    expect((await waitForJob(file.id)).status).toBe('succeeded');
    const createdFile = (await readJson(await fetch(`${base}/documents`))).find((d: any) => d.source === 'job-fr.txt');
    expect(createdFile.language).toBe('french');
    await remove(createdFile.id);
  });

  it('resolves the default language when a job leaves it out', async () => {
    const text = await readJson(await json('POST', '/jobs/documents', { title: 'Job default', content: 'Default language words. Unique-marker-ten.' }));
    expect((await waitForJob(text.id)).status).toBe('succeeded');
    const created = (await readJson(await fetch(`${base}/documents`))).find((d: any) => d.title === 'Job default');
    expect(created.language).toBe('english');
    await remove(created.id);
  });
});

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
    const [embedding] = await app.get<EmbeddingProvider>(EMBEDDING_PROVIDER).embed([question]);
    const rows = await (app.get(QueryService) as any).lexicalSearch(toVector(embedding), question, 20, owner, documentIds);
    return (rows as { title: string }[]).map((r) => r.title);
  };

  const DE = 'Die Rechnungen werden jährlich bezahlt. Kündigungen sind monatlich möglich.';

  it('finds a German document by an inflected word only when it is indexed as german', async () => {
    await add('DE as german', DE, 'german');
    await add('DE as english', `${DE} Anderer Text.`, 'english');
    // Index side: German stems "Rechnungen" to "rechnung"; indexed as English it stays "rechnungen".
    expect(await lexical('Rechnung')).toEqual(['DE as german']);
  });

  it('stems the question with the language of each document it searches', async () => {
    await add('DE as german', DE, 'german');
    await add('DE as english', `${DE} Anderer Text.`, 'english');
    // Query side: "Rechnungen" is "rechnung" for the German document and stays "rechnungen" for the English one;
    // a single fixed configuration would find only one of the two.
    expect((await lexical('Rechnungen')).sort()).toEqual(['DE as english', 'DE as german']);
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

  it("does not look at another user's documents or languages", async () => {
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
    // "été" is itself a French stop word; the content word is "factures". Everything else is punctuation to survive.
    expect(await lexical("l'été, c'est ça? (les factures) & | ! :")).toEqual(['FR']);
  });

  it('still answers a question when no document matches', async () => {
    expect(await lexical('zzzzqqqq')).toEqual([]);
  });
});
