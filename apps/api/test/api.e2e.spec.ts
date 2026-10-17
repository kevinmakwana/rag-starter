/**
 * End-to-end test against a real Postgres + pgvector, using the offline mock providers.
 * Runs when E2E_DATABASE_URL is set (CI provides one); skipped otherwise.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readdir, readFile } from 'fs/promises';
import { AddressInfo } from 'net';
import { join, resolve } from 'path';
import { Client } from 'pg';
import { APP_CONFIG, AppConfig } from '../src/config';
import { evaluate } from '../src/eval/evaluate';
import { QueryService } from '../src/query/query.service';

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
    const mode = cfg.searchMode;
    cfg.searchMode = 'vector'; // hybrid's full-text half would rescue the passage and hide the problem
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
      cfg.searchMode = mode;
      await fetch(`${base}/documents/${big.id}`, { method: 'DELETE' });
      await fetch(`${base}/documents/${small.id}`, { method: 'DELETE' });
    }
  });

  it('keeps vector search complete while many deleted chunks are still in the index', async () => {
    // Deleting a document leaves its HNSW entries behind until VACUUM. A plain index scan spends its
    // candidate slots on them and can come back with nothing live, so deletes would silently degrade search.
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
});
