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
});
