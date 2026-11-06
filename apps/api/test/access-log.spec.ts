import express from 'express';
import type { AddressInfo } from 'node:net';
import { accessLogMiddleware, formatText } from '../src/observability/access-log';
import { annotateQuery, recordModelCall, startModelCall } from '../src/observability/request-context';

async function serve() {
  const lines: string[] = [];
  const app = express();
  app.use(accessLogMiddleware('json', (line) => lines.push(line)));
  app.get('/things/:id', (_req, res) => {
    recordModelCall({ kind: 'chat', provider: 'p', model: 'm', inputTokens: 10, outputTokens: 5, ms: 1 });
    annotateQuery({ retrieved: 2, retrieveMs: 3 });
    res.json({ ok: true });
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/boom', (_req, res) => res.status(500).json({ error: true }));
  app.get('/slow-stream', (_req, res) => {
    res.write('partial');
    // never ends: the client walks away
  });
  app.get('/pending-model', (_req, res) => {
    // A model call is in flight when the visitor leaves, and it only reports back afterwards.
    const call = startModelCall({ kind: 'chat', provider: 'p', model: 'm' });
    res.once('close', () => setTimeout(() => call.finish({ inputTokens: 40, outputTokens: 2 }), 30));
    res.write('partial');
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const waitForLines = async (n: number) => {
    for (let i = 0; i < 100 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  return { base, lines, waitForLines, close };
}

describe('access log middleware', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => {
    s = await serve();
  });
  afterEach(async () => s.close());

  it('gives every response an id, and reuses a well-formed one from the client', async () => {
    const plain = await fetch(`${s.base}/things/1`);
    expect(plain.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);

    const mine = await fetch(`${s.base}/things/1`, { headers: { 'x-request-id': 'client-req_12345' } });
    expect(mine.headers.get('x-request-id')).toBe('client-req_12345');
  });

  it.each([['short'], ['has spaces in it'], ['x'.repeat(65)], ['bad;chars!!']])(
    'replaces a malformed client id (%s) instead of echoing it',
    async (bad) => {
      const res = await fetch(`${s.base}/things/1`, { headers: { 'x-request-id': bad } });
      expect(res.headers.get('x-request-id')).not.toBe(bad);
      expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('writes one JSON line per request with the route pattern, never the real path or query string', async () => {
    const res = await fetch(`${s.base}/things/secret-123?q=private`);
    await s.waitForLines(1);

    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).not.toContain('secret-123');
    expect(s.lines[0]).not.toContain('private');
    const line = JSON.parse(s.lines[0]);
    expect(line).toMatchObject({
      context: 'http',
      message: 'request',
      method: 'GET',
      route: '/things/:id',
      status: 200,
      aborted: false,
      requestId: res.headers.get('x-request-id'),
    });
    expect(typeof line.durationMs).toBe('number');
    expect(line.usage).toEqual({ calls: 1, inputTokens: 10, outputTokens: 5, tokensUnknown: false });
    expect(line.query).toEqual({ retrieved: 2, retrieveMs: 3 });
  });

  it('logs "(unmatched)" for a path no route handles, not the path itself', async () => {
    await fetch(`${s.base}/wp-admin/setup.php`);
    await s.waitForLines(1);
    const line = JSON.parse(s.lines[0]);
    expect(line.route).toBe('(unmatched)');
    expect(line.status).toBe(404);
    expect(s.lines[0]).not.toContain('wp-admin');
  });

  it('does not log a successful health check, but still logs a failing request', async () => {
    await fetch(`${s.base}/health`);
    await fetch(`${s.base}/boom`);
    await s.waitForLines(1);
    expect(s.lines).toHaveLength(1);
    expect(JSON.parse(s.lines[0]).route).toBe('/boom');
  });

  it('keeps usage and query out of the line for a request that made no model call', async () => {
    await fetch(`${s.base}/boom`);
    await s.waitForLines(1);
    const line = JSON.parse(s.lines[0]);
    expect(line).not.toHaveProperty('usage');
    expect(line).not.toHaveProperty('query');
  });

  it('logs a request the client abandoned, flagged aborted', async () => {
    const controller = new AbortController();
    const pending = fetch(`${s.base}/slow-stream`, { signal: controller.signal }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    await pending;
    await s.waitForLines(1);
    expect(JSON.parse(s.lines[0])).toMatchObject({ route: '/slow-stream', aborted: true });
  });
});

describe('access log for an abandoned request whose model call is still running', () => {
  it('counts that call, with its tokens unknown, instead of leaving it out of the line', async () => {
    const s = await serve();
    try {
      const controller = new AbortController();
      const pending = fetch(`${s.base}/pending-model`, { signal: controller.signal }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      await pending;
      await s.waitForLines(1);
      const line = JSON.parse(s.lines[0]);
      expect(line.aborted).toBe(true);
      expect(line.usage).toMatchObject({ calls: 1, tokensUnknown: true });
    } finally {
      await s.close();
    }
  });
});

describe('formatText', () => {
  it('is a readable one-liner with the id, and shows tokens only when models were called', () => {
    const base = { requestId: 'abc', method: 'POST', route: '/query', status: 200, durationMs: 123, aborted: false };
    expect(formatText(base)).toBe('POST /query 200 123ms req=abc');
    expect(
      formatText({
        ...base,
        aborted: true,
        usage: { calls: 2, inputTokens: 30, outputTokens: 12, tokensUnknown: true },
      }),
    ).toBe('POST /query 200 123ms req=abc aborted model-calls=2 tokens=30/12+');
  });
});
