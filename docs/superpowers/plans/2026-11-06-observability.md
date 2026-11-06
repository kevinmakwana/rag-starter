# Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every request gets an ID and one structured log line (route, status, duration), and every question's line also carries phase timings and the tokens its model calls used, so the operator of the public demo can see what a question costs and diagnose problems. Visitors' questions, answers and addresses are never logged.

**Architecture:** An Express middleware (first in `configureApp`) assigns `X-Request-Id`, opens an `AsyncLocalStorage` request context, and on response close writes one access line. The OpenAI and Anthropic providers add a `ModelCall` to the current context after each call (signatures unchanged, so the question rewrite, reranker and eval judge are metered too). `QueryService` annotates the context with phase timings. `LOG_FORMAT=json` switches Nest's own logger to `ConsoleLogger({ json: true })` and the access line to JSON; the production overlay sets it.

**Tech Stack:** NestJS 12.3 (`ConsoleLogger` JSON mode), Express, `node:async_hooks`, Jest 30 (ts-jest ESM), `openai` 7.45, `@anthropic-ai/sdk` 1.3.

**Design:** approved in chat on 2026-11-06 (no separate spec file, at the user's request). Consolidations made while planning, recorded here as the binding record: (a) one access line per request carries the query details instead of a second summary line; (b) no custom JSON logger, because Nest's `ConsoleLogger` already has a JSON mode; (c) successful `GET /health` requests are not logged (the container healthchecks would add thousands of lines a day); (d) only the provider-error line, not every framework line, carries the request ID.

## Global Constraints

- Never log a question, an answer, a document's text, an IP address, an API key, a query string or a raw request path (log the route pattern, `(unmatched)` for no match).
- Provider interfaces (`ChatProvider.complete/stream`, `EmbeddingProvider.embed`) keep their signatures.
- `OpenAIChatProvider` sends `stream_options: { include_usage: true }` only when no custom `OPENAI_BASE_URL` is set; with a custom base URL streamed-answer tokens are reported as unknown.
- An interrupted stream records its call with the tokens it never received left unknown, never guessed.
- `LOG_FORMAT` accepts `text` (default) or `json`; anything else fails at startup naming the variable.
- Database-backed tests live only in `apps/api/test/api.e2e.spec.ts`; every other new test is a separate file without a database.
- Jest 30 ESM has no `jest` global. Dev runs with `ts-node --transpile-only`, so every injected constructor parameter needs an explicit `@Inject(...)`.
- `apps/web/lib` is untouched by this plan.
- Never pipe a gating command (`npm test | tail`); redirect to a file in the scratchpad and read the exit code.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A request ID supplied by a client must be validated: a header with spaces, newlines or 500 characters must be replaced, never echoed (Task 1).
2. The log line must never contain the path parameters, query string or body: `GET /documents/<secret>?q=...` logs `/documents/:id` (Task 1).
3. Concurrent requests must not mix their model calls: two simultaneous questions each report only their own tokens (Task 1).
4. A streamed answer the client abandons must still produce a line, flagged `aborted`, with tokens left unknown rather than zero (Tasks 1, 2).
5. A provider that returns no `usage` (compatible servers, the mock) must not break a request or produce `NaN`/`0` tokens that look real (Tasks 2, 3).
6. `/health` polled every 10 seconds must not fill the log (Task 1).

---

### Task 1: Request IDs, the request context, and the access log

**Files:**
- Create: `apps/api/src/observability/request-context.ts`
- Create: `apps/api/src/observability/access-log.ts`
- Modify: `apps/api/src/config.ts` (add `logFormat`)
- Modify: `apps/api/src/app.setup.ts` (register the middleware, expose the header)
- Modify: `apps/api/src/main.ts` (JSON logger, buffered logs)
- Test: `apps/api/test/request-context.spec.ts`, `apps/api/test/access-log.spec.ts`, `apps/api/test/log-config.spec.ts`, plus one case in `apps/api/test/api.e2e.spec.ts`

**Interfaces:**
- Consumes: `AppConfig` (`config.ts`), `configureApp(app, cfg)` (`app.setup.ts`).
- Produces (later tasks import exactly these names from `src/observability/request-context.ts`): `ModelCall`, `QueryTelemetry`, `RequestContext`, `runInRequestContext(ctx, fn)`, `currentRequestContext()`, `currentRequestId()`, `recordModelCall(call)`, `annotateQuery(fields)`, `summariseCalls(calls)` returning `UsageSummary { calls, inputTokens, outputTokens, tokensUnknown }`. From `access-log.ts`: `accessLogMiddleware(format, sink?)`, `formatText(entry)`, `LogFormat`. `AppConfig.logFormat: 'text' | 'json'`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/request-context.spec.ts`:

```ts
import {
  ModelCall,
  RequestContext,
  annotateQuery,
  currentRequestContext,
  recordModelCall,
  runInRequestContext,
  summariseCalls,
} from '../src/observability/request-context';

const call = (over: Partial<ModelCall> = {}): ModelCall => ({
  kind: 'chat',
  provider: 'p',
  model: 'm',
  inputTokens: 10,
  outputTokens: 5,
  ms: 1,
  ...over,
});

describe('request context', () => {
  it('records nothing outside a request (scripts, tests, startup seeding)', () => {
    expect(() => recordModelCall(call())).not.toThrow();
    expect(() => annotateQuery({ retrieved: 1 })).not.toThrow();
    expect(currentRequestContext()).toBeUndefined();
  });

  it('collects model calls and query telemetry for the current request', () => {
    const ctx: RequestContext = { requestId: 'r1', calls: [] };
    runInRequestContext(ctx, () => {
      recordModelCall(call());
      annotateQuery({ retrieveMs: 4 });
      annotateQuery({ retrieved: 3 });
    });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.query).toEqual({ retrieveMs: 4, retrieved: 3 });
  });

  it('keeps simultaneous requests apart', async () => {
    const a: RequestContext = { requestId: 'a', calls: [] };
    const b: RequestContext = { requestId: 'b', calls: [] };
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await Promise.all([
      runInRequestContext(a, async () => {
        await pause(15);
        recordModelCall(call({ inputTokens: 1 }));
      }),
      runInRequestContext(b, async () => {
        recordModelCall(call({ inputTokens: 2 }));
        await pause(30);
        recordModelCall(call({ inputTokens: 3 }));
      }),
    ]);
    expect(a.calls.map((c) => c.inputTokens)).toEqual([1]);
    expect(b.calls.map((c) => c.inputTokens)).toEqual([2, 3]);
  });
});

describe('summariseCalls', () => {
  it('adds up tokens across calls', () => {
    expect(summariseCalls([call(), call({ inputTokens: 20, outputTokens: 7 })])).toEqual({
      calls: 2,
      inputTokens: 30,
      outputTokens: 12,
      tokensUnknown: false,
    });
  });

  it('says so when any call did not report its tokens, instead of counting it as zero', () => {
    const s = summariseCalls([call(), call({ inputTokens: undefined, outputTokens: undefined })]);
    expect(s).toMatchObject({ calls: 2, inputTokens: 10, outputTokens: 5, tokensUnknown: true });
  });

  it('is empty for no calls', () => {
    expect(summariseCalls([])).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, tokensUnknown: false });
  });
});
```

Create `apps/api/test/access-log.spec.ts`:

```ts
import express from 'express';
import type { AddressInfo } from 'node:net';
import { formatText, accessLogMiddleware } from '../src/observability/access-log';
import { annotateQuery, recordModelCall } from '../src/observability/request-context';

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
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const waitForLines = async (n: number) => {
    for (let i = 0; i < 100 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const close = () => new Promise<void>((resolve) => (server.closeAllConnections?.(), server.close(() => resolve())));
  return { base, lines, waitForLines, close };
}

describe('access log middleware', () => {
  let s: Awaited<ReturnType<typeof serve>>;
  beforeEach(async () => (s = await serve()));
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

  it('does not log a successful health check, but still logs a failing one', async () => {
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
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await pending;
    await s.waitForLines(1);
    expect(JSON.parse(s.lines[0])).toMatchObject({ route: '/slow-stream', aborted: true });
  });
});

describe('formatText', () => {
  it('is a readable one-liner with the id, and shows tokens only when models were called', () => {
    const base = { requestId: 'abc', method: 'POST', route: '/query', status: 200, durationMs: 123, aborted: false };
    expect(formatText(base)).toBe('POST /query 200 123ms req=abc');
    expect(
      formatText({ ...base, usage: { calls: 2, inputTokens: 30, outputTokens: 12, tokensUnknown: true }, aborted: true }),
    ).toBe('POST /query 200 123ms req=abc aborted model-calls=2 tokens=30/12+');
  });
});
```

Create `apps/api/test/log-config.spec.ts`:

```ts
import { loadConfig } from '../src/config';

describe('loadConfig for logging', () => {
  const saved = process.env.LOG_FORMAT;
  afterEach(() => (saved === undefined ? delete process.env.LOG_FORMAT : (process.env.LOG_FORMAT = saved)));

  it('defaults to text', () => {
    delete process.env.LOG_FORMAT;
    expect(loadConfig().logFormat).toBe('text');
  });

  it('accepts json', () => {
    process.env.LOG_FORMAT = 'json';
    expect(loadConfig().logFormat).toBe('json');
  });

  it('rejects anything else, naming the variable', () => {
    process.env.LOG_FORMAT = 'xml';
    expect(() => loadConfig()).toThrow(/LOG_FORMAT/);
  });
});
```

Add to `apps/api/test/api.e2e.spec.ts`, inside the existing top-level describe that has the running app and a `request`/fetch helper (read the file's existing helpers first and follow them): a test named `gives every response an X-Request-Id and exposes it to browsers` that does a `GET /health` with an `Origin` header equal to the configured CORS origin and asserts `x-request-id` is present and `access-control-expose-headers` contains `X-Request-Id`.

- [ ] **Step 2: Run the new tests to see them fail**

Run: `cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest test/request-context.spec.ts test/access-log.spec.ts test/log-config.spec.ts > "$SCRATCHPAD/t1-red.log" 2>&1; echo "exit=$?"; grep -E "Cannot find module|Tests:|Suites:" "$SCRATCHPAD/t1-red.log" | head`
Expected: `exit=1`, "Cannot find module" for the two observability files, and the config test failing on `logFormat` (undefined).

- [ ] **Step 3: Write the request context**

Create `apps/api/src/observability/request-context.ts`:

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

/** One call to a model provider made while handling a request. Tokens are absent when the provider did not report them. */
export interface ModelCall {
  kind: 'chat' | 'embedding';
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  ms: number;
}

/** What the question pipeline measured. Never holds the question or the answer. */
export interface QueryTelemetry {
  rewriteMs?: number;
  retrieveMs?: number;
  answerMs?: number;
  retrieved?: number;
  citationsMissing?: boolean;
}

export interface RequestContext {
  requestId: string;
  calls: ModelCall[];
  query?: QueryTelemetry;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** True when some call did not report its tokens, so the totals are a lower bound. */
  tokensUnknown: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runInRequestContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);
export const currentRequestContext = (): RequestContext | undefined => storage.getStore();
export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;

/** Record a model call against the current request. A no-op outside a request (scripts, tests, startup seeding). */
export function recordModelCall(call: ModelCall): void {
  storage.getStore()?.calls.push(call);
}

/** Merge what the question pipeline measured into the current request. */
export function annotateQuery(fields: QueryTelemetry): void {
  const ctx = storage.getStore();
  if (ctx) ctx.query = { ...ctx.query, ...fields };
}

export function summariseCalls(calls: readonly ModelCall[]): UsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let tokensUnknown = false;
  for (const c of calls) {
    if (c.inputTokens === undefined || c.outputTokens === undefined) tokensUnknown = true;
    inputTokens += c.inputTokens ?? 0;
    outputTokens += c.outputTokens ?? 0;
  }
  return { calls: calls.length, inputTokens, outputTokens, tokensUnknown };
}
```

- [ ] **Step 4: Write the access log middleware**

Create `apps/api/src/observability/access-log.ts`:

```ts
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { QueryTelemetry, RequestContext, UsageSummary, runInRequestContext, summariseCalls } from './request-context';

export type LogFormat = 'text' | 'json';
export type LogSink = (line: string) => void;

/** A client-supplied id is only kept when it is plain and short; anything else could forge or flood log lines. */
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export interface AccessLogEntry {
  requestId: string;
  method: string;
  /** The route pattern ("/documents/:id"), never the real path, so ids and query strings stay out of the log. */
  route: string;
  status: number;
  durationMs: number;
  /** The client went away before the response finished. */
  aborted: boolean;
  usage?: UsageSummary;
  query?: QueryTelemetry;
}

export function formatText(entry: AccessLogEntry): string {
  const parts = [`${entry.method} ${entry.route} ${entry.status} ${entry.durationMs}ms`, `req=${entry.requestId}`];
  if (entry.aborted) parts.push('aborted');
  if (entry.usage) {
    const { calls, inputTokens, outputTokens, tokensUnknown } = entry.usage;
    parts.push(`model-calls=${calls}`, `tokens=${inputTokens}/${outputTokens}${tokensUnknown ? '+' : ''}`);
  }
  return parts.join(' ');
}

function routeOf(req: Request): string {
  const path = req.route?.path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : '(unmatched)';
}

const stdout: LogSink = (line) => void process.stdout.write(`${line}\n`);
const http = new Logger('http');

/**
 * Gives each request an id (header `X-Request-Id`), opens its context, and writes one access line when the
 * response closes. In JSON the line uses the same keys as Nest's own JSON logger (level, pid, timestamp,
 * context, message) plus the fields above, so one `jq` filter works across the whole log.
 */
export function accessLogMiddleware(format: LogFormat, sink: LogSink = stdout): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const supplied = req.get('x-request-id');
    const requestId = supplied && CLIENT_REQUEST_ID.test(supplied) ? supplied : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const ctx: RequestContext = { requestId, calls: [] };
    const started = process.hrtime.bigint();

    res.once('close', () => {
      const route = routeOf(req);
      // Healthchecks poll every few seconds; only a failing one is worth a line.
      if (route === '/health' && res.statusCode < 400) return;
      const entry: AccessLogEntry = {
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        aborted: !res.writableFinished,
        ...(ctx.calls.length ? { usage: summariseCalls(ctx.calls) } : {}),
        ...(ctx.query ? { query: ctx.query } : {}),
      };
      if (format === 'json') {
        sink(JSON.stringify({ level: 'log', pid: process.pid, timestamp: Date.now(), context: 'http', message: 'request', ...entry }));
      } else {
        http.log(formatText(entry));
      }
    });

    runInRequestContext(ctx, next);
  };
}
```

- [ ] **Step 5: Add the config, wire the middleware, expose the header, set up the logger**

In `apps/api/src/config.ts` add to `AppConfig`: `logFormat: 'text' | 'json';` and to the object `loadConfig()` returns: `logFormat: oneOf('LOG_FORMAT', ['text', 'json'] as const, 'text'),`. If any test builds an `AppConfig` literal without a cast and fails to typecheck, add the field there.

In `apps/api/src/app.setup.ts` add `import { accessLogMiddleware, LogSink } from './observability/access-log';` and change the function head and CORS block to:

```ts
export function configureApp(app: NestExpressApplication, cfg: AppConfig, accessLogSink?: LogSink): void {
  // First, so every response (including a CORS preflight or a rejected request) carries an id and gets a line.
  app.use(accessLogMiddleware(cfg.logFormat, accessLogSink));
  app.enableCors({
    origin: cfg.corsOrigin.split(',').map((o) => o.trim()),
    // Browsers hide other response headers from scripts; the web app shows "try again in N seconds",
    // and a visitor can quote the request id when reporting a problem.
    exposedHeaders: ['Retry-After', 'X-Request-Id'],
  });
```

(keep the rest of the function unchanged).

In `apps/api/src/main.ts` change the import to `import { ConsoleLogger, Logger } from '@nestjs/common';`, create the app with buffered logs, and select the logger once the config is known:

```ts
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const cfg = app.get<AppConfig>(APP_CONFIG);
  // JSON lines for every Nest log too, so the whole log can be filtered with jq. Buffered logs are replayed through it.
  if (cfg.logFormat === 'json') app.useLogger(new ConsoleLogger({ json: true }));
```

(replacing the two existing lines that create the app and read the config).

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest test/request-context.spec.ts test/access-log.spec.ts test/log-config.spec.ts > "$SCRATCHPAD/t1-green.log" 2>&1; echo "exit=$?"; grep -E "Tests:|Suites:" "$SCRATCHPAD/t1-green.log"`
Expected: `exit=0`, all three suites pass. If the "abandoned request" test is flaky, increase its 50 ms pause before changing code.

- [ ] **Step 7: Run it for real, then the whole suite**

```bash
cd apps/api && npm run build > "$SCRATCHPAD/build.log" 2>&1; echo "build-exit=$?"
DATABASE_URL=postgres://rag:rag@localhost:5433/rag_eval API_PORT=4010 LOG_FORMAT=json node dist/main.js > "$SCRATCHPAD/run.log" 2>&1 &
sleep 8
curl -s -D - -o /dev/null http://127.0.0.1:4010/documents/not-a-uuid-123?x=secret | grep -i "x-request-id"
curl -s -o /dev/null http://127.0.0.1:4010/health
kill %1; wait 2>/dev/null
grep -c . "$SCRATCHPAD/run.log"; grep '"context":"http"' "$SCRATCHPAD/run.log"; grep -c "secret\|not-a-uuid" "$SCRATCHPAD/run.log"
```

Expected: `build-exit=0`; an `x-request-id` header; the log file shows Nest's own lines as JSON (`"level":"log"` with `"context":"NestFactory"` etc.), exactly one `"context":"http"` line (for the `/documents/:id` request, status 400 or 404, route `/documents/:id`) and none for `/health`; and `0` lines containing `secret` or `not-a-uuid`. Then run the whole suite from the repo root: `E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_test npm test > "$SCRATCHPAD/t1-full.log" 2>&1; echo "exit=$?"; grep -E "^(Tests|Test Suites):|^# (pass|fail)" "$SCRATCHPAD/t1-full.log"` and `npm run typecheck > "$SCRATCHPAD/t1-tc.log" 2>&1; echo "tc-exit=$?"`. Expected: exit 0 for both, the e2e header test included.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/observability apps/api/src/config.ts apps/api/src/app.setup.ts apps/api/src/main.ts apps/api/test
git commit -m "$(cat <<'EOF'
Give every request an id and one structured access log line

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Meter model calls in the providers

**Files:**
- Modify: `apps/api/src/providers/openai.provider.ts`
- Modify: `apps/api/src/providers/anthropic.provider.ts`
- Modify: `apps/api/src/providers/providers.module.ts`
- Test: `apps/api/test/providers.spec.ts` (add cases)

**Interfaces:**
- Consumes: `recordModelCall`, `ModelCall` from Task 1.
- Produces: `OpenAIChatProvider(client, model, reportStreamUsage = true)`; every provider call appends one `ModelCall` to the current request context. The mock providers are unchanged (they report nothing).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/providers.spec.ts` (merge the imports with the existing ones; `OpenAIChatProvider` and the request-context helpers are new):

```ts
import { OpenAIChatProvider } from '../src/providers/openai.provider';
import { ModelCall, RequestContext, runInRequestContext } from '../src/observability/request-context';

/** Run `fn` inside a request context and return the model calls it recorded. */
async function metered(fn: () => Promise<unknown>): Promise<ModelCall[]> {
  const ctx: RequestContext = { requestId: 'test-request', calls: [] };
  await runInRequestContext(ctx, fn);
  return ctx.calls;
}

describe('OpenAI usage metering', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  const chatClient = (reply: (req: any) => any) => {
    const requests: any[] = [];
    const client = { chat: { completions: { create: async (req: any) => (requests.push(req), reply(req)) } } } as any;
    return { client, requests };
  };

  it('records the tokens of a completed answer', async () => {
    const { client } = chatClient(() => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }));
    const calls = await metered(() => new OpenAIChatProvider(client, 'gpt-x').complete(messages));
    expect(calls).toEqual([
      expect.objectContaining({ kind: 'chat', provider: 'openai', model: 'gpt-x', inputTokens: 120, outputTokens: 30 }),
    ]);
  });

  it('records the call without tokens when the server reports no usage (instead of inventing zeros)', async () => {
    const { client } = chatClient(() => ({ choices: [{ message: { content: 'ok' } }] }));
    const [call] = await metered(() => new OpenAIChatProvider(client, 'gpt-x').complete(messages));
    expect(call.inputTokens).toBeUndefined();
    expect(call.outputTokens).toBeUndefined();
  });

  it('asks a streamed answer to include usage, and records it from the final chunk', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } },
    ];
    const { client, requests } = chatClient(() => (async function* () { yield* chunks; })());
    let text = '';
    const calls = await metered(async () => {
      for await (const t of new OpenAIChatProvider(client, 'gpt-x').stream(messages)) text += t;
    });
    expect(text).toBe('Hello');
    expect(requests[0].stream_options).toEqual({ include_usage: true });
    expect(calls[0]).toMatchObject({ inputTokens: 50, outputTokens: 2 });
  });

  it('does not send stream_options to a custom base URL, and reports that answer’s tokens as unknown', async () => {
    const { client, requests } = chatClient(() => (async function* () { yield { choices: [{ delta: { content: 'x' } }] }; })());
    const calls = await metered(async () => {
      for await (const _ of new OpenAIChatProvider(client, 'llama', false).stream(messages)) void _;
    });
    expect(requests[0]).not.toHaveProperty('stream_options');
    expect(calls[0].inputTokens).toBeUndefined();
  });

  it('still records a streamed answer the caller stopped reading, with tokens unknown', async () => {
    const { client } = chatClient(() => (async function* () {
      yield { choices: [{ delta: { content: 'a' } }] };
      yield { choices: [{ delta: { content: 'b' } }] };
      yield { choices: [], usage: { prompt_tokens: 9, completion_tokens: 9 } };
    })());
    const calls = await metered(async () => {
      for await (const _ of new OpenAIChatProvider(client, 'gpt-x').stream(messages)) {
        void _;
        break; // the visitor closed the page
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].inputTokens).toBeUndefined();
  });

  it('records embedding tokens per batch, with no output tokens', async () => {
    const client = {
      embeddings: {
        create: async (req: any) => ({
          data: req.input.map((_: string, index: number) => ({ index, embedding: [0.1, 0.2] })),
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }),
      },
    } as any;
    const calls = await metered(() => new OpenAIEmbeddingProvider(client, 'text-embedding-3-small', 2).embed(['a', 'b']));
    expect(calls).toEqual([
      expect.objectContaining({ kind: 'embedding', provider: 'openai', model: 'text-embedding-3-small', inputTokens: 7, outputTokens: 0 }),
    ]);
  });
});

describe('Anthropic usage metering', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  it('records the tokens of a completed answer', async () => {
    const client = {
      messages: { create: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 80, output_tokens: 12 } }) },
    } as any;
    const calls = await metered(() => new AnthropicChatProvider(client, 'claude-x').complete(messages));
    expect(calls).toEqual([
      expect.objectContaining({ kind: 'chat', provider: 'anthropic', model: 'claude-x', inputTokens: 80, outputTokens: 12 }),
    ]);
  });

  it('records a streamed answer’s tokens from message_start (input) and message_delta (output so far)', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 60, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
      { type: 'message_delta', usage: { output_tokens: 9 } },
    ];
    const client = { messages: { stream: () => (async function* () { yield* events; })() } } as any;
    let text = '';
    const calls = await metered(async () => {
      for await (const t of new AnthropicChatProvider(client, 'claude-x').stream(messages)) text += t;
    });
    expect(text).toBe('Hi');
    expect(calls[0]).toMatchObject({ inputTokens: 60, outputTokens: 9 });
  });

  it('records an abandoned stream with the tokens it never received left unknown', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 60, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
    ];
    const client = { messages: { stream: () => (async function* () { yield* events; })() } } as any;
    const calls = await metered(async () => {
      for await (const _ of new AnthropicChatProvider(client, 'claude-x').stream(messages)) {
        void _;
        break;
      }
    });
    expect(calls[0].inputTokens).toBe(60);
    expect(calls[0].outputTokens).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest test/providers.spec.ts > "$SCRATCHPAD/t2-red.log" 2>&1; echo "exit=$?"; grep -E "✕|Tests:" "$SCRATCHPAD/t2-red.log" | head -14`
Expected: `exit=1`, the new metering tests failing (no calls recorded: `[]`, and no `stream_options`), the existing provider tests still passing.

- [ ] **Step 3: Meter the OpenAI providers**

In `apps/api/src/providers/openai.provider.ts` add `import { recordModelCall } from '../observability/request-context';`. In `embed`, time each batch and record it:

```ts
      const started = Date.now();
      const res = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        // Only text-embedding-3 models accept `dimensions`; other servers reject the request outright.
        ...(/^text-embedding-3/.test(this.model) ? { dimensions: this.dimensions } : {}),
      });
      recordModelCall({
        kind: 'embedding',
        provider: this.name,
        model: this.model,
        inputTokens: res.usage?.prompt_tokens,
        outputTokens: 0,
        ms: Date.now() - started,
      });
```

Replace the chat provider with:

```ts
export class OpenAIChatProvider implements ChatProvider {
  readonly name = 'openai';

  /**
   * `reportStreamUsage` asks a streamed answer to end with a usage chunk. Servers other than OpenAI's own
   * (Ollama, vLLM, ...) may reject the option, so the caller turns it off for a custom base URL and the
   * tokens of streamed answers are then unknown.
   */
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly reportStreamUsage = true,
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const started = Date.now();
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0.1,
    });
    recordModelCall({
      kind: 'chat',
      provider: this.name,
      model: this.model,
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
      ms: Date.now() - started,
    });
    return res.choices[0]?.message?.content?.trim() ?? '';
  }

  async *stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const started = Date.now();
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        temperature: 0.1,
        stream: true,
        ...(this.reportStreamUsage ? { stream_options: { include_usage: true } } : {}),
      },
      { signal },
    );
    try {
      for await (const chunk of res) {
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    } finally {
      // Runs when the caller stops reading too: the usage chunk comes last, so an abandoned stream has none.
      recordModelCall({
        kind: 'chat',
        provider: this.name,
        model: this.model,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        ms: Date.now() - started,
      });
    }
  }
}
```

- [ ] **Step 4: Meter the Anthropic provider**

In `apps/api/src/providers/anthropic.provider.ts` add `import { recordModelCall } from '../observability/request-context';` and replace `stream` and `complete` with:

```ts
  async *stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const started = Date.now();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const stream = this.client.messages.stream(this.toRequest(messages), { signal });
    try {
      for await (const event of stream) {
        if (event.type === 'message_start') inputTokens = event.message.usage.input_tokens;
        // Cumulative: each message_delta carries the total output tokens so far.
        else if (event.type === 'message_delta') outputTokens = event.usage.output_tokens;
        else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
      }
    } finally {
      // An abandoned stream never reaches its final message_delta, so outputTokens stays unknown.
      recordModelCall({ kind: 'chat', provider: this.name, model: this.model, inputTokens, outputTokens, ms: Date.now() - started });
    }
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const started = Date.now();
    const res = await this.client.messages.create(this.toRequest(messages));
    recordModelCall({
      kind: 'chat',
      provider: this.name,
      model: this.model,
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
      ms: Date.now() - started,
    });
    return res.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }
```

Note the existing test `uses it for streamed answers too` passes a stream stub yielding nothing; it must still pass.

- [ ] **Step 5: Turn stream usage off for a custom base URL**

In `apps/api/src/providers/providers.module.ts`, change the OpenAI chat construction to:

```ts
      // A custom base URL (Ollama, vLLM, ...) may not support `stream_options`, so streamed tokens stay unknown there.
      return new OpenAIChatProvider(openAIClient(cfg), cfg.openai.chatModel, !cfg.openai.baseUrl);
```

- [ ] **Step 6: Run the tests, the typecheck and the whole suite**

Run: `cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest test/providers.spec.ts > "$SCRATCHPAD/t2-green.log" 2>&1; echo "exit=$?"; grep -E "Tests:|Suites:" "$SCRATCHPAD/t2-green.log"`, then from the repo root `npm run typecheck > "$SCRATCHPAD/t2-tc.log" 2>&1; echo "tc-exit=$?"` and `E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_test npm test > "$SCRATCHPAD/t2-full.log" 2>&1; echo "exit=$?"`.
Expected: all exit 0. If `tsc` rejects `event.message.usage` or `chunk.usage` types, fix the access to match the installed SDK types (read them under `node_modules/openai` and `node_modules/@anthropic-ai/sdk`) rather than casting to `any`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/providers apps/api/test/providers.spec.ts
git commit -m "$(cat <<'EOF'
Record the tokens and time of every OpenAI and Anthropic call against its request

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Phase timings for questions, and the request id on provider errors

**Files:**
- Modify: `apps/api/src/query/query.service.ts`
- Modify: `apps/api/src/common/provider-error.filter.ts`
- Test: `apps/api/test/query-telemetry.spec.ts` (create), `apps/api/test/provider-error-filter.spec.ts` (create)

**Interfaces:**
- Consumes: `annotateQuery`, `currentRequestId`, `runInRequestContext` from Task 1.
- Produces: `RequestContext.query` filled with `{ rewriteMs?, retrieveMs, answerMs, retrieved, citationsMissing? }` for `ask`, `askWithPassages` and `askStream`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/query-telemetry.spec.ts` (fixtures follow `test/ask-passages.spec.ts`):

```ts
import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { RequestContext, runInRequestContext } from '../src/observability/request-context';
import { MockEmbeddingProvider } from '../src/providers/mock.provider';
import { ChatProvider } from '../src/providers/types';
import { QueryService } from '../src/query/query.service';

const cfg = { topK: 5, minScore: 0, historyMessages: 4 } as AppConfig;
const row = {
  chunkId: '1',
  documentId: '00000000-0000-0000-0000-000000000000',
  title: 'Pricing',
  heading: 'Billing',
  content: 'Annual plans are billed once a year.',
  score: 0.8,
};
const chat = (answer: string): ChatProvider => ({
  name: 'fake',
  async complete() {
    return answer;
  },
  async *stream() {
    yield answer;
  },
});
const serviceWith = (rows: unknown[], answer = 'Billed yearly [1].') =>
  new QueryService(cfg, new MockEmbeddingProvider(64), chat(answer), { query: async () => ({ rows }) } as any);

const inRequest = async (fn: () => Promise<unknown>) => {
  const ctx: RequestContext = { requestId: 'test-request', calls: [] };
  await runInRequestContext(ctx, fn);
  return ctx;
};

describe('query telemetry', () => {
  it('records retrieval and answer time and how many passages were found', async () => {
    const ctx = await inRequest(() => serviceWith([row]).ask('How are annual plans billed?'));
    expect(ctx.query).toMatchObject({ retrieved: 1 });
    expect(typeof ctx.query?.retrieveMs).toBe('number');
    expect(typeof ctx.query?.answerMs).toBe('number');
    expect(ctx.query).not.toHaveProperty('rewriteMs'); // no history, so no rewrite call
    expect(ctx.query).not.toHaveProperty('citationsMissing');
  });

  it('records the rewrite time only when a follow-up was actually rewritten', async () => {
    const history = [
      { role: 'user' as const, content: 'What plans exist?' },
      { role: 'assistant' as const, content: 'Free and Team.' },
    ];
    const ctx = await inRequest(() => serviceWith([row]).ask('and annual?', 5, undefined, history));
    expect(typeof ctx.query?.rewriteMs).toBe('number');
  });

  it('flags an answer that cites none of the passages', async () => {
    const ctx = await inRequest(() => serviceWith([row], 'It depends.').ask('How are annual plans billed?'));
    expect(ctx.query?.citationsMissing).toBe(true);
  });

  it('still records time and a zero count when nothing was retrieved, without an answer time', async () => {
    const ctx = await inRequest(() => serviceWith([]).ask('Unrelated question?'));
    expect(ctx.query).toMatchObject({ retrieved: 0 });
    expect(typeof ctx.query?.retrieveMs).toBe('number');
    expect(ctx.query).not.toHaveProperty('answerMs');
  });

  it('records the same for a streamed answer', async () => {
    const ctx = await inRequest(async () => {
      for await (const _ of serviceWith([row]).askStream('How are annual plans billed?')) void _;
    });
    expect(ctx.query).toMatchObject({ retrieved: 1 });
    expect(typeof ctx.query?.retrieveMs).toBe('number');
    expect(typeof ctx.query?.answerMs).toBe('number');
  });

  it('records the retrieval time even when the visitor abandons the stream before the answer', async () => {
    const ctx = await inRequest(async () => {
      for await (const event of serviceWith([row]).askStream('How are annual plans billed?')) {
        if (event.type === 'sources') break;
      }
    });
    expect(typeof ctx.query?.retrieveMs).toBe('number');
  });

  it('does nothing outside a request', async () => {
    await expect(serviceWith([row]).ask('How are annual plans billed?')).resolves.toBeDefined();
  });
});
```

Create `apps/api/test/provider-error-filter.spec.ts`:

```ts
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { ProviderErrorFilter } from '../src/common/provider-error.filter';
import { RequestContext, runInRequestContext } from '../src/observability/request-context';

describe('ProviderErrorFilter', () => {
  const host = () => {
    const sent: { status?: number; body?: any } = {};
    const res = { status: (s: number) => ((sent.status = s), res), json: (b: any) => (sent.body = b) };
    return { sent, host: { switchToHttp: () => ({ getResponse: () => res }) } as any };
  };

  it('puts the request id in the log line, so the error can be matched to its access line', () => {
    const logged: string[] = [];
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => void logged.push(String(m)));
    const { sent, host: h } = host();
    const ctx: RequestContext = { requestId: 'req-abc12345', calls: [] };
    runInRequestContext(ctx, () => new ProviderErrorFilter().catch(new OpenAI.APIError(429, {}, 'rate limited', {}) as any, h));
    expect(sent.status).toBe(502);
    expect(logged[0]).toContain('req=req-abc12345');
    jest.restoreAllMocks();
  });
});
```

Note: ESM Jest has no `jest` global. If `jest.spyOn`/`jest.restoreAllMocks` are unavailable, replace the spy with `Logger.overrideLogger` using a recording logger object `{ log() {}, warn() {}, error: (m) => logged.push(String(m)) }` and restore with `Logger.overrideLogger(new ConsoleLogger())` in `afterEach`.

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest test/query-telemetry.spec.ts test/provider-error-filter.spec.ts > "$SCRATCHPAD/t3-red.log" 2>&1; echo "exit=$?"; grep -E "✕|Tests:" "$SCRATCHPAD/t3-red.log" | head -12`
Expected: `exit=1`; every telemetry assertion except "does nothing outside a request" failing (`ctx.query` is undefined), and the filter test failing on the missing `req=`.

- [ ] **Step 3: Instrument the query service**

In `apps/api/src/query/query.service.ts` add `import { annotateQuery } from '../observability/request-context';`. Add this helper to the class, near `standalone`:

```ts
  /** Run `fn` and record how long it took in the request's telemetry, even when it throws. */
  private async timed<T>(field: 'retrieveMs' | 'answerMs', fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      annotateQuery({ [field]: Date.now() - started });
    }
  }
```

In `standalone`, time the rewrite model call (only when one is made):

```ts
    try {
      const started = Date.now();
      const raw = await this.chat.complete(buildRewriteMessages(question, recent));
      annotateQuery({ rewriteMs: Date.now() - started });
```

In `toResult`, before `return`, add `annotateQuery({ retrieved: chunks.length, ...(uncited ? { citationsMissing: true } : {}) });`.

In `askWithPassages`, replace the retrieve and answer lines with:

```ts
    const chunks = await this.timed('retrieveMs', () => this.retrieve(searchQuestion, topK, documentIds, owner));

    const answer = chunks.length
      ? await this.timed('answerMs', () => this.chat.complete(buildMessages(searchQuestion, chunks)))
      : NO_CONTEXT_ANSWER;
```

In `askStream`, replace the retrieve line with `const chunks = await this.timed('retrieveMs', () => this.retrieve(searchQuestion, topK, documentIds, owner));` and time the answer loop manually:

```ts
    let answer = '';
    if (chunks.length) {
      const answerStarted = Date.now();
      try {
        for await (const text of this.chat.stream(buildMessages(searchQuestion, chunks), signal)) {
          answer += text;
          yield { type: 'token', text };
        }
      } finally {
        annotateQuery({ answerMs: Date.now() - answerStarted });
      }
    } else {
```

(the `else` branch and the final `done` event stay as they are).

- [ ] **Step 4: Put the request id in the provider-error log**

In `apps/api/src/common/provider-error.filter.ts` add `import { currentRequestId } from '../observability/request-context';` and change the log line to:

```ts
    this.logger.error(`${err.status ?? '?'} ${err.message} (req=${currentRequestId() ?? '-'})`);
```

- [ ] **Step 5: Run the tests, typecheck and the whole suite**

Run: `cd apps/api && NODE_OPTIONS=--experimental-vm-modules npx jest test/query-telemetry.spec.ts test/provider-error-filter.spec.ts test/ask-passages.spec.ts test/stream.spec.ts > "$SCRATCHPAD/t3-green.log" 2>&1; echo "exit=$?"; grep -E "Tests:|Suites:" "$SCRATCHPAD/t3-green.log"`, then `npm run typecheck > "$SCRATCHPAD/t3-tc.log" 2>&1; echo "tc-exit=$?"` and the full suite as in Task 2 Step 6.
Expected: all exit 0 (the existing query and stream suites must be unaffected).

- [ ] **Step 6: See a question's line end to end**

```bash
cd apps/api && npm run build > "$SCRATCHPAD/build.log" 2>&1; echo "build-exit=$?"
DATABASE_URL=postgres://rag:rag@localhost:5433/rag_eval API_PORT=4010 LOG_FORMAT=json DEMO_MODE=true node dist/main.js > "$SCRATCHPAD/run2.log" 2>&1 &
sleep 12
curl -s -X POST http://127.0.0.1:4010/query -H 'content-type: application/json' -d '{"question":"Can I deploy on Fridays?"}' > /dev/null
curl -s -N -X POST http://127.0.0.1:4010/query/stream -H 'content-type: application/json' -d '{"question":"What does the Team plan cost?"}' > /dev/null
kill %1; wait 2>/dev/null
grep '"route":"/query' "$SCRATCHPAD/run2.log"; grep -c "Fridays\|Team plan" "$SCRATCHPAD/run2.log"
```

Expected: two `http` lines (`/query` and `/query/stream`), each with a `query` object (`retrieved`, `retrieveMs`, `answerMs`) and, with the mock providers, no `usage` (they report no tokens); `0` lines containing the question text.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/query/query.service.ts apps/api/src/common/provider-error.filter.ts apps/api/test/query-telemetry.spec.ts apps/api/test/provider-error-filter.spec.ts
git commit -m "$(cat <<'EOF'
Record question timings in the request log and tag provider errors with the request id

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Production JSON logs and documentation

**Files:**
- Modify: `docker-compose.prod.yml` (`LOG_FORMAT: json` for the API)
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/deployment.md`
- Modify: `TODO.md`

**Interfaces:**
- Consumes: `LOG_FORMAT`, the log schema from Tasks 1-3 (keys `context`, `message`, `requestId`, `method`, `route`, `status`, `durationMs`, `aborted`, `usage{calls,inputTokens,outputTokens,tokensUnknown}`, `query{rewriteMs,retrieveMs,answerMs,retrieved,citationsMissing}`).

- [ ] **Step 1: Write the failing check**

Run: `grep -c "LOG_FORMAT" docker-compose.prod.yml .env.example README.md docs/deployment.md`
Expected: every count `0`.

- [ ] **Step 2: The production overlay logs JSON**

In `docker-compose.prod.yml`, in the `api` service's `environment:` block add (keeping the quoting style of its neighbours):

```yaml
      # One JSON object per line (Nest's logs and one line per request), for jq. See "Reading the logs" in the guide.
      LOG_FORMAT: "json"
```

Run `SITE_ADDRESS=x.test POSTGRES_PASSWORD=x docker compose -f docker-compose.yml -f docker-compose.prod.yml config | grep LOG_FORMAT` → `LOG_FORMAT: json`, and the same validation exits 0 with `config -q`.

- [ ] **Step 3: Document the setting and the log fields**

In `.env.example`, after the `HISTORY_MESSAGES` block, add:

```
# "json" prints one JSON object per line (Nest's own logs and one line per request) for jq or a log shipper;
# "text" is readable in a terminal. The production overlay sets json.
LOG_FORMAT=text
```

In `README.md`, add a section `## Logs and usage` before `## Background jobs` containing:

```markdown
## Logs and usage

Every response carries an `X-Request-Id` header (a client-sent one is kept only if it is 8-64 plain characters), and every request writes one line when it finishes: method, the route pattern (`/documents/:id`, never the real path or query string), status, duration, and `aborted` if the client left first. Successful `GET /health` calls are not logged. Questions, answers, document text and IP addresses are never logged.

A question's line adds what it cost:

- `query`: `retrieveMs`, `answerMs`, `rewriteMs` (only for a follow-up that was rewritten), `retrieved` (passages found) and `citationsMissing`.
- `usage`: `calls` (model calls, including the rewrite and re-ranking), `inputTokens`, `outputTokens`, and `tokensUnknown`, which is `true` when some call did not report its tokens (the totals are then a lower bound). OpenAI and Anthropic report tokens; the mock providers report none. A streamed OpenAI answer reports tokens only against OpenAI itself, not against a custom `OPENAI_BASE_URL`, and an answer the visitor abandons mid-stream has none.

`LOG_FORMAT=json` makes Nest's own log lines JSON too, so one `jq` filter reads the whole log (see [docs/deployment.md](docs/deployment.md#reading-the-logs)). There is no metrics endpoint or OpenTelemetry export yet; the request context in `src/observability/` is where one would hook in.
```

- [ ] **Step 4: The guide gets "Reading the logs"**

In `docs/deployment.md`, add before the `## Check that visitors are told apart` section:

````markdown
## Reading the logs

With the production overlay the API writes one JSON object per line. Install `jq` on the server (`sudo apt install jq`). The filters skip lines that are not JSON, because a few start-up lines are plain text.

```bash
# every request, newest last
docker compose logs --no-log-prefix api | jq -cR 'fromjson? | select(.context=="http")'

# the slowest requests
docker compose logs --no-log-prefix api | jq -cR 'fromjson? | select(.context=="http") | {route, status, durationMs, requestId}' | jq -s 'sort_by(-.durationMs) | .[0:10]'

# model calls and tokens in the last 24 hours (a lower bound if tokensUnknown is true on some lines)
docker compose logs --no-log-prefix --since 24h api | jq -sR '[split("\n")[] | fromjson? | select(.context=="http" and .usage) | .usage] | {requests: length, calls: (map(.calls) | add), inputTokens: (map(.inputTokens) | add), outputTokens: (map(.outputTokens) | add), withUnknownTokens: (map(select(.tokensUnknown)) | length)}'

# one visitor's report: find the request by the id shown in the response header (X-Request-Id)
docker compose logs --no-log-prefix api | grep REQUEST_ID
```

Multiply the token totals by your provider's current prices to estimate the day's spend; the logs deliberately do not hard-code prices. The authoritative number is your provider's usage page. Questions, answers and visitor addresses are not in the logs by design, so you cannot read what people asked, only how much it cost.
````

Add to the "What has and has not been tested" section's tested list: `the request log lines and the jq filters above against real output of the stack`.

- [ ] **Step 5: Run the guide's filters against real output**

Bring up the production test stack as in the deployment plan (project `ragprod`, `SITE_ADDRESS=localhost`, a fresh random `POSTGRES_PASSWORD`, `$SCRATCHPAD/prod-test.yml` mapping Caddy to 8080/8443 with `DEMO_MODE=true`), after rebuilding the API image (`up --build`). Send a few requests through Caddy (`curl -sk https://localhost:8443/api/query ...` twice, one `/api/documents`, one 404 path), then run each `jq` command from Step 4 with `-p ragprod -f ...` flags added to `docker compose logs`, reading the output.
Expected: the first prints only `http` lines with the route patterns (`/query`, `/documents`, `(unmatched)`); the second prints sorted objects; the third prints an object (with the mock providers `inputTokens`/`outputTokens` are `0` or `null`, so also verify it against a synthetic file: `printf '%s\n' '{"context":"http","usage":{"calls":2,"inputTokens":30,"outputTokens":12,"tokensUnknown":false}}' 'not json' '{"context":"http","usage":{"calls":1,"inputTokens":5,"outputTokens":1,"tokensUnknown":true}}' | jq -sR '<the same filter>'` → `requests 2, calls 3, inputTokens 35, outputTokens 13, withUnknownTokens 1`); no line contains the question text or an IP. Tear down only this project: `docker compose -p ragprod ... down -v`.

- [ ] **Step 6: Tick the TODO, check, commit**

In `TODO.md` change the Observability line to:

```
- [x] **Observability.** `X-Request-Id` on every response and one structured log line per request (route pattern, status, duration), plus per-question phase timings and the tokens each model call used; `LOG_FORMAT=json` for jq. Questions, answers and addresses are never logged. OpenTelemetry and a metrics endpoint are not done: the request context in `src/observability/` is the hook.
```

Run: `grep -c "LOG_FORMAT" docker-compose.prod.yml .env.example README.md docs/deployment.md; git status -sb | head -8`.
Expected: each count at least `1`; only the five files changed.

```bash
git add docker-compose.prod.yml .env.example README.md docs/deployment.md TODO.md
git commit -m "$(cat <<'EOF'
Log JSON in production and document the request log and its fields

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

- **Design coverage:** request ids and the access log (Task 1); token metering in OpenAI chat/stream/embeddings and Anthropic chat/stream with custom-base-URL handling (Task 2); phase timings, the rewrite/rerank calls metered via the providers, the provider-error request id (Task 3); `LOG_FORMAT`, JSON for Nest's own logs, the production overlay, README, the guide with jq commands, TODO (Tasks 1, 4). Out of scope as agreed: OpenTelemetry, `/metrics`, dollar cost, logging questions/answers/addresses.
- **Placeholders:** none. The one pointer to existing code (`api.e2e.spec.ts` helpers) names the file and the assertion to add.
- **Type consistency:** `ModelCall`, `QueryTelemetry`, `RequestContext`, `UsageSummary`, `recordModelCall`, `annotateQuery`, `runInRequestContext`, `currentRequestId`, `accessLogMiddleware(format, sink?)`, `OpenAIChatProvider(client, model, reportStreamUsage)` are spelled identically in every task.
