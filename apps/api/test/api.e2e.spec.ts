/**
 * End-to-end test against a real Postgres + pgvector, using the offline mock providers.
 * Runs when E2E_DATABASE_URL is set (CI provides one); skipped otherwise.
 */
import 'reflect-metadata';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';

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
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
});
