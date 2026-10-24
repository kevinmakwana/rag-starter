/**
 * The real app and real routes with a tiny costly limit, against Postgres + the mock providers.
 * Runs when E2E_DATABASE_URL is set (CI provides one); skipped otherwise.
 */
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'net';

const DB = process.env.E2E_DATABASE_URL;
const describeIfDb = DB ? describe : describe.skip;

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
