/**
 * HTTP-level tests for POST /query/stream with a stubbed QueryService (no database needed):
 * framing and headers, errors before and after the stream opens, and client disconnects.
 */
import 'reflect-metadata';
import { INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AddressInfo } from 'net';
import { QueryController } from '../src/query/query.controller';
import { QueryService, QueryStreamEvent } from '../src/query/query.service';

const result = { answer: 'ok', sources: [], meta: { embeddingProvider: 'm', chatProvider: 'm', retrieved: 0, tookMs: 1 } };

let askStream: (...args: any[]) => AsyncGenerator<QueryStreamEvent>;

@Module({
  controllers: [QueryController],
  providers: [{ provide: QueryService, useValue: { askStream: (...args: any[]) => askStream(...args) } }],
})
class TestModule {}

describe('POST /query/stream', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.listen(0);
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (body: unknown, signal?: AbortSignal) =>
    fetch(`${base}/query/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

  it('writes each event as an SSE frame with streaming headers', async () => {
    askStream = async function* () {
      yield { type: 'sources', sources: [] };
      yield { type: 'token', text: 'o' };
      yield { type: 'token', text: 'k' };
      yield { type: 'done', result };
    };

    const res = await post({ question: 'hi' });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(await res.text()).toBe(
      'event: sources\ndata: {"sources":[]}\n\n' +
        'event: token\ndata: {"text":"o"}\n\n' +
        'event: token\ndata: {"text":"k"}\n\n' +
        `event: done\ndata: ${JSON.stringify({ result })}\n\n`,
    );
  });

  it('passes the question, filters and history through to the service', async () => {
    let args: any[] = [];
    askStream = async function* (...a: any[]) {
      args = a;
      yield { type: 'done', result };
    };
    const history = [{ role: 'user', content: 'earlier' }];

    await (await post({ question: '  padded  ', topK: 3, history })).text();

    expect(args[0]).toBe('padded');
    expect(args[1]).toBe(3);
    expect(args[3]).toBeInstanceOf(AbortSignal);
    expect(args[4]).toEqual(history);
  });

  it('turns a failure after the stream opened into an error event', async () => {
    askStream = async function* () {
      yield { type: 'sources', sources: [] };
      throw new Error('upstream exploded');
    };

    const frames = (await (await post({ question: 'hi' })).text()).split('\n\n').filter(Boolean);

    expect(frames[0]).toMatch(/^event: sources/);
    expect(frames[1]).toBe('event: error\ndata: {"message":"upstream exploded"}');
  });

  it('answers with a normal HTTP error when it fails before anything was sent', async () => {
    askStream = async function* () {
      throw new Error('database down');
    };

    const res = await post({ question: 'hi' });

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('aborts the upstream call when the client disconnects', async () => {
    let aborted: Promise<void> = Promise.resolve();
    askStream = async function* (_q, _k, _d, signal: AbortSignal) {
      aborted = new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      yield { type: 'sources', sources: [] };
      await aborted; // would hang forever if the disconnect were never noticed
    };

    const client = new AbortController();
    const res = await post({ question: 'hi' }, client.signal);
    await res.body!.getReader().read(); // first frame arrived: the stream is open
    client.abort();

    let timer: NodeJS.Timeout;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('never aborted')), 2000);
    });
    await expect(Promise.race([aborted, timeout]).finally(() => clearTimeout(timer))).resolves.toBeUndefined();
  });
});
