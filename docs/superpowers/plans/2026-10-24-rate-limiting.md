# Rate Limiting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-caller request limits (general and costly tiers) with `429` + `Retry-After`, plus an explicit JSON body limit, so a public instance cannot be used to run up model cost.

**Architecture:** `@nestjs/throttler` with in-memory storage and two named throttlers (`general`, `costly`). A small `AppThrottlerGuard` subclass supplies the caller identity (user id when API keys are configured, IP otherwise), a per-tier counter key, and the `Retry-After` header. It is registered as a global guard after `AuthGuard`. A shared `configureApp()` applies CORS, pipes, filters, `trust proxy` and the body limit, so `main.ts` and the tests exercise the same setup.

**Tech Stack:** NestJS 12, `@nestjs/throttler` 6.7.1, Express, Jest 30 (ts-jest ESM), Next.js (web app).

**Spec:** `docs/superpowers/specs/2026-10-24-rate-limiting-design.md`

## Global Constraints

- Defaults: general `300` / minute (`RATE_LIMIT_PER_MIN`), costly `20` / minute (`RATE_LIMIT_COSTLY_PER_MIN`); window 60 seconds; `0` turns a tier off; negative, fractional or non-numeric values are startup errors naming the variable.
- `TRUST_PROXY`: unset or `false` (default), `true`, or a whole number of hops; anything else is a startup error naming `TRUST_PROXY`.
- Caller = user id when `API_KEYS` is set, else client IP (`request.ip`). The throttler guard runs after `AuthGuard`.
- `@Public()` routes (`/health`) are never throttled.
- Over the limit: `429` JSON error plus `Retry-After` in whole seconds. No SSE stream is opened for `POST /query/stream`.
- Costly routes (exactly these): `POST /query`, `POST /query/stream`, `POST /documents`, `PUT /documents/:id`, `POST /documents/upload`, `POST /documents/reindex`, `POST /documents/:id/reindex`, `POST /jobs/documents`, `POST /jobs/upload`, `POST /jobs/reindex`. A costly request counts against both tiers.
- Counters live in memory; no new table; the quickstart (no keys, mock providers) keeps working.
- Dev runs with `ts-node --transpile-only`, which emits no decorator metadata: every injected constructor parameter needs an explicit `@Inject(...)`, as in `AuthGuard`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Rulings (found while writing the plan; the spec is amended to match)

- **Per-tier counter keys.** The library's default key is `class-handler-throttler-tracker`, which would make every route its own bucket. The guard overrides `generateKey` to `<throttler>:<tracker>`, so the general budget is shared by all routes and the costly budget by all costly routes. Cost if wrong: limits would be per route and much looser than documented.
- **`Retry-After` is set by us.** For a named throttler the library emits `Retry-After-costly`, not `Retry-After`. The throttlers set `setHeaders: false` and the guard sets `Retry-After` itself (from `timeToBlockExpire`, which the library computes in whole seconds). The `X-RateLimit-*` headers are dropped; the spec never asked for them.
- **Browsers can only read `Retry-After` if CORS exposes it.** `enableCors` gets `exposedHeaders: ['Retry-After']`, otherwise the web app's "try again in N seconds" would always fall back to the generic text.
- **IPv6.** The tracker uses the library's `normalizeIp(req.ip, 64)` so one client rotating addresses inside its /64 cannot dodge the limit.

## Review Focus

Failure modes the spec implies; each has a test in the task that owns the code.

1. Spoofed `X-Forwarded-For` with `TRUST_PROXY` unset must not create new buckets (Task 2).
2. A costly request must also consume the general budget, and the costly budget must be shared across routes (Task 2).
3. A request rejected by `AuthGuard` never reaches the throttler, and a user's bucket is not affected by another user's (Task 2).
4. Real route handlers must carry `@Costly()`; marking drift is silent (Task 3).
5. A limit of `0` for both tiers must leave the app working (Task 2).

---

### Task 1: Rate-limit and proxy config

**Files:**
- Modify: `apps/api/src/config.ts`
- Create: `apps/api/test/rate-limit-config.spec.ts`

**Interfaces:**
- Produces: `AppConfig.rateLimit: { perMinute: number; costlyPerMinute: number }` and `AppConfig.trustProxy: boolean | number`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/rate-limit-config.spec.ts`:

```ts
import { loadConfig } from '../src/config';

describe('loadConfig for rate limiting', () => {
  const KEYS = ['RATE_LIMIT_PER_MIN', 'RATE_LIMIT_COSTLY_PER_MIN', 'TRUST_PROXY'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    KEYS.forEach((k) => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
  });
  afterEach(() => {
    KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  });

  it('defaults to 300 general and 20 costly requests per minute, trusting no proxy', () => {
    const cfg = loadConfig();
    expect(cfg.rateLimit).toEqual({ perMinute: 300, costlyPerMinute: 20 });
    expect(cfg.trustProxy).toBe(false);
  });

  it('reads both limits, and 0 turns a tier off', () => {
    Object.assign(process.env, { RATE_LIMIT_PER_MIN: '0', RATE_LIMIT_COSTLY_PER_MIN: '5' });
    expect(loadConfig().rateLimit).toEqual({ perMinute: 0, costlyPerMinute: 5 });
  });

  it.each([
    ['RATE_LIMIT_PER_MIN', '-1'],
    ['RATE_LIMIT_PER_MIN', '1.5'],
    ['RATE_LIMIT_PER_MIN', 'lots'],
    ['RATE_LIMIT_COSTLY_PER_MIN', '-5'],
    ['RATE_LIMIT_COSTLY_PER_MIN', '2.5'],
  ])('rejects %s=%s, naming the variable', (name, value) => {
    process.env[name] = value;
    expect(() => loadConfig()).toThrow(new RegExp(name));
  });

  it.each([
    [undefined, false],
    ['', false],
    ['false', false],
    ['true', true],
    ['1', 1],
    ['2', 2],
  ])('reads TRUST_PROXY=%s as %p', (raw, expected) => {
    if (raw !== undefined) process.env.TRUST_PROXY = raw;
    expect(loadConfig().trustProxy).toBe(expected);
  });

  it.each(['yes', '-1', '1.5', 'loopback'])('rejects TRUST_PROXY=%s', (value) => {
    process.env.TRUST_PROXY = value;
    expect(() => loadConfig()).toThrow(/TRUST_PROXY/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w apps/api -- rate-limit-config`
Expected: FAIL (`cfg.rateLimit` is undefined, and the `toThrow` cases do not throw).

- [ ] **Step 3: Implement**

In `apps/api/src/config.ts`, add to `AppConfig` (after `historyMessages`):

```ts
  /** Requests per minute per caller. `costlyPerMinute` also applies to routes that call a model. 0 = no limit. */
  rateLimit: { perMinute: number; costlyPerMinute: number };
  /** Express `trust proxy`: `true`, or how many proxy hops to trust, so the client IP is the real one. */
  trustProxy: boolean | number;
```

Add helpers after `oneOf`:

```ts
function wholeNumber(name: string, fallback: number): number {
  const value = int(name, fallback);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a whole number, 0 or more`);
  return value;
}

function trustProxy(name: string): boolean | number {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  throw new Error(`${name} must be true, false or a whole number of proxy hops, got "${process.env[name]}"`);
}
```

Add to the `cfg` object, after `historyMessages`:

```ts
    rateLimit: { perMinute: wholeNumber('RATE_LIMIT_PER_MIN', 300), costlyPerMinute: wholeNumber('RATE_LIMIT_COSTLY_PER_MIN', 20) },
    trustProxy: trustProxy('TRUST_PROXY'),
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -w apps/api -- rate-limit-config`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config.ts apps/api/test/rate-limit-config.spec.ts
git commit -m "Add rate limit and TRUST_PROXY config

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Throttler guard, module and `configureApp`

**Files:**
- Modify: `apps/api/package.json` (dependency), `package-lock.json`
- Create: `apps/api/src/rate-limit/costly.decorator.ts`
- Create: `apps/api/src/rate-limit/rate-limit.module.ts`
- Create: `apps/api/src/rate-limit/app-throttler.guard.ts`
- Create: `apps/api/src/app.setup.ts`
- Modify: `apps/api/src/main.ts`
- Test: `apps/api/test/rate-limit.spec.ts`, `apps/api/test/body-limit.spec.ts`

**Interfaces:**
- Consumes: `AppConfig.rateLimit`, `AppConfig.trustProxy` (Task 1); `AuthGuard`, `Public`, `IS_PUBLIC`.
- Produces:
  - `Costly(): MethodDecorator & ClassDecorator`, `IS_COSTLY: string` (`rate-limit/costly.decorator.ts`)
  - `RateLimitModule` (a dynamic module; imports into `AppModule`) and `buildThrottlers(rateLimit): ThrottlerOptions[]` (`rate-limit/rate-limit.module.ts`)
  - `AppThrottlerGuard` (`rate-limit/app-throttler.guard.ts`), constructor `(options, storage, reflector, cfg)`
  - `configureApp(app: NestExpressApplication, cfg: AppConfig): void` (`app.setup.ts`)

- [ ] **Step 1: Install the dependency**

Run: `npm install @nestjs/throttler@6.7.1 -w apps/api`
Expected: `apps/api/package.json` gains `"@nestjs/throttler": "^6.7.1"`.

- [ ] **Step 2: Write the failing tests**

Create `apps/api/test/rate-limit.spec.ts`:

```ts
import 'reflect-metadata';
import { Controller, Get, INestApplication, Module, Post } from '@nestjs/common';
import { APP_GUARD, NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'net';
import { configureApp } from '../src/app.setup';
import { hashKey } from '../src/auth/api-keys';
import { AuthGuard } from '../src/auth/auth.guard';
import { Public } from '../src/auth/public.decorator';
import { APP_CONFIG, AppConfig } from '../src/config';
import { AppThrottlerGuard } from '../src/rate-limit/app-throttler.guard';
import { Costly } from '../src/rate-limit/costly.decorator';
import { RateLimitModule } from '../src/rate-limit/rate-limit.module';

@Controller()
class Probe {
  @Get('cheap')
  cheap() {
    return { ok: true };
  }

  @Costly()
  @Post('a')
  a() {
    return { ok: true };
  }

  @Costly()
  @Post('b')
  b() {
    return { ok: true };
  }

  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }
}

const ALICE = 'alice-key-0123456789';
const BOB = 'bobs-key-abcdefghijk';

interface Options {
  perMinute?: number;
  costlyPerMinute?: number;
  keys?: Record<string, string>;
  trustProxy?: boolean | number;
}

describe('rate limiting', () => {
  const apps: INestApplication[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function start(over: Options = {}) {
    const cfg = {
      corsOrigin: 'http://localhost:3000',
      auth: { keys: new Map(Object.entries(over.keys ?? {}).map(([key, user]) => [hashKey(key), user])) },
      rateLimit: { perMinute: over.perMinute ?? 0, costlyPerMinute: over.costlyPerMinute ?? 0 },
      trustProxy: over.trustProxy ?? false,
    } as unknown as AppConfig;

    @Module({
      imports: [
        { module: class ConfigModule {}, global: true, providers: [{ provide: APP_CONFIG, useValue: cfg }], exports: [APP_CONFIG] },
        RateLimitModule,
      ],
      controllers: [Probe],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: AppThrottlerGuard },
      ],
    })
    class TestModule {}

    const app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    configureApp(app, cfg);
    await app.listen(0);
    apps.push(app);
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    return (method: 'GET' | 'POST', path: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method, headers });
  }

  const as = (key: string) => ({ authorization: `Bearer ${key}` });

  it('answers 429 with a numeric Retry-After and a JSON body once the costly limit is used up', async () => {
    const call = await start({ costlyPerMinute: 2 });

    expect((await call('POST', '/a')).status).toBe(201);
    expect((await call('POST', '/a')).status).toBe(201);
    const limited = await call('POST', '/a');

    expect(limited.status).toBe(429);
    expect(limited.headers.get('content-type')).toMatch(/application\/json/);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
    expect((await limited.json()).statusCode).toBe(429);
  });

  it('shares one costly budget across all costly routes, and leaves cheap routes alone', async () => {
    const call = await start({ costlyPerMinute: 2 });

    expect((await call('POST', '/a')).status).toBe(201);
    expect((await call('POST', '/b')).status).toBe(201);
    expect((await call('POST', '/a')).status).toBe(429);
    expect((await call('POST', '/b')).status).toBe(429);
    expect((await call('GET', '/cheap')).status).toBe(200);
  });

  it('shares one general budget across all routes', async () => {
    const call = await start({ perMinute: 3 });

    expect((await call('GET', '/cheap')).status).toBe(200);
    expect((await call('POST', '/a')).status).toBe(201);
    expect((await call('POST', '/b')).status).toBe(201);
    expect((await call('GET', '/cheap')).status).toBe(429);
  });

  it('counts a costly request against the general budget too', async () => {
    const call = await start({ perMinute: 2, costlyPerMinute: 10 });

    expect((await call('POST', '/a')).status).toBe(201);
    expect((await call('POST', '/a')).status).toBe(201);
    expect((await call('POST', '/a')).status).toBe(429);
  });

  it('never limits a public route such as /health', async () => {
    const call = await start({ perMinute: 1, costlyPerMinute: 1 });

    for (let i = 0; i < 5; i++) expect((await call('GET', '/health')).status).toBe(200);
  });

  it('does not limit a tier set to 0, and works with both tiers off', async () => {
    const costlyOff = await start({ perMinute: 2, costlyPerMinute: 0 });
    expect((await costlyOff('POST', '/a')).status).toBe(201);
    expect((await costlyOff('POST', '/a')).status).toBe(201);
    expect((await costlyOff('POST', '/a')).status).toBe(429); // the general tier still applies

    const bothOff = await start({ perMinute: 0, costlyPerMinute: 0 });
    for (let i = 0; i < 30; i++) expect((await bothOff('POST', '/a')).status).toBe(201);
  });

  it('limits each user separately when API keys are configured', async () => {
    const call = await start({ costlyPerMinute: 1, keys: { [ALICE]: 'alice', [BOB]: 'bob' } });

    expect((await call('POST', '/a', as(ALICE))).status).toBe(201);
    expect((await call('POST', '/a', as(ALICE))).status).toBe(429);
    expect((await call('POST', '/a', as(BOB))).status).toBe(201);
  });

  it('shares a user budget across that user\'s keys and clients', async () => {
    const call = await start({ costlyPerMinute: 1, keys: { [ALICE]: 'alice', [BOB]: 'alice' } });

    expect((await call('POST', '/a', { ...as(ALICE), 'x-forwarded-for': '1.1.1.1' })).status).toBe(201);
    expect((await call('POST', '/a', { ...as(BOB), 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
  });

  it('rejects a wrong key with 401 before the throttler, and does not spend the budget', async () => {
    const call = await start({ costlyPerMinute: 1, keys: { [ALICE]: 'alice' } });

    expect((await call('POST', '/a', as('wrong-key-0123456789'))).status).toBe(401);
    expect((await call('POST', '/a', as(ALICE))).status).toBe(201);
  });

  it('limits each client IP separately when authentication is off and a proxy is trusted', async () => {
    const call = await start({ costlyPerMinute: 1, trustProxy: true });

    expect((await call('POST', '/a', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(201);
    expect((await call('POST', '/a', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(429);
    expect((await call('POST', '/a', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(201);
  });

  it('ignores X-Forwarded-For unless a proxy is trusted, so it cannot be spoofed to dodge the limit', async () => {
    const call = await start({ costlyPerMinute: 1, trustProxy: false });

    expect((await call('POST', '/a', { 'x-forwarded-for': '1.1.1.1' })).status).toBe(201);
    expect((await call('POST', '/a', { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
  });

  it('lets a browser on the allowed origin read Retry-After', async () => {
    const call = await start({ costlyPerMinute: 1 });
    const origin = { origin: 'http://localhost:3000' };
    await call('POST', '/a', origin);

    const limited = await call('POST', '/a', origin);

    expect(limited.status).toBe(429);
    expect(limited.headers.get('access-control-expose-headers')).toMatch(/Retry-After/i);
  });
});

describe('AppThrottlerGuard tracker', () => {
  const guard = (keys: [string, string][]) =>
    new AppThrottlerGuard(
      [],
      {} as never,
      new Reflector(),
      { auth: { keys: new Map(keys.map(([key, user]) => [hashKey(key), user])) } } as unknown as AppConfig,
    ) as unknown as { getTracker(req: object): Promise<string>; generateKey(ctx: never, tracker: string, name: string): string };

  it('is the user id when authentication is on', async () => {
    expect(await guard([[ALICE, 'alice']]).getTracker({ user: { id: 'alice' }, ip: '9.9.9.9' })).toBe('user:alice');
  });

  it('is the IP when authentication is off, even though every request then has the default user', async () => {
    expect(await guard([]).getTracker({ user: { id: 'default' }, ip: '9.9.9.9' })).toBe('ip:9.9.9.9');
  });

  it('puts IPv6 addresses of one /64 in the same bucket', async () => {
    const g = guard([]);
    expect(await g.getTracker({ ip: '2001:db8:1:2::1' })).toBe(await g.getTracker({ ip: '2001:db8:1:2:ffff::9' }));
    expect(await g.getTracker({ ip: '2001:db8:1:2::1' })).not.toBe(await g.getTracker({ ip: '2001:db8:1:3::1' }));
  });

  it('keys counters by tier and caller, not by route', () => {
    const ctx = (name: string) => ({ getClass: () => ({ name: 'C' }), getHandler: () => ({ name }) }) as never;
    const g = guard([]);
    expect(g.generateKey(ctx('a'), 'ip:1.1.1.1', 'costly')).toBe(g.generateKey(ctx('b'), 'ip:1.1.1.1', 'costly'));
    expect(g.generateKey(ctx('a'), 'ip:1.1.1.1', 'costly')).not.toBe(g.generateKey(ctx('a'), 'ip:1.1.1.1', 'general'));
  });
});
```

Create `apps/api/test/body-limit.spec.ts`:

```ts
import 'reflect-metadata';
import { Body, Controller, INestApplication, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'net';
import { configureApp } from '../src/app.setup';
import { APP_CONFIG, AppConfig } from '../src/config';
import { CreateDocumentDto, MAX_DOCUMENT_CHARS } from '../src/documents/documents.dto';

@Controller('documents')
class Probe {
  @Post()
  create(@Body() dto: CreateDocumentDto) {
    return { chars: dto.content.length };
  }
}

describe('JSON body limit', () => {
  const cfg = { corsOrigin: 'http://localhost:3000', trustProxy: false } as unknown as AppConfig;
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  @Module({
    imports: [{ module: class ConfigModule {}, global: true, providers: [{ provide: APP_CONFIG, useValue: cfg }], exports: [APP_CONFIG] }],
    controllers: [Probe],
  })
  class TestModule {}

  const post = async (configure: boolean, content: string) => {
    const nest = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    if (configure) configureApp(nest, cfg);
    await nest.listen(0);
    app = nest;
    const base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
    return fetch(`${base}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Big', content }),
    });
  };

  it('is the reason for the explicit limit: the framework default rejects a document well under the character cap', async () => {
    const res = await post(false, 'a'.repeat(400_000));
    expect(res.status).toBe(413);
  });

  it('accepts a document at the character cap, even when JSON escaping makes the body several times larger', async () => {
    const res = await post(true, '"'.repeat(MAX_DOCUMENT_CHARS));
    expect(res.status).toBe(201);
    expect((await res.json()).chars).toBe(MAX_DOCUMENT_CHARS);
  });

  it('still rejects a body far beyond the cap', async () => {
    const res = await post(true, 'a'.repeat(6_000_000));
    expect(res.status).toBe(413);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `npm test -w apps/api -- rate-limit.spec body-limit`
Expected: both files FAIL to compile/run because `../src/app.setup` and `../src/rate-limit/*` do not exist.

- [ ] **Step 4: Implement the decorator**

Create `apps/api/src/rate-limit/costly.decorator.ts`:

```ts
import { SetMetadata } from '@nestjs/common';

export const IS_COSTLY = 'isCostly';

/** Mark a route that calls a model (chat or embeddings): it also counts against the lower "costly" limit. */
export const Costly = () => SetMetadata(IS_COSTLY, true);
```

- [ ] **Step 5: Implement the module**

Create `apps/api/src/rate-limit/rate-limit.module.ts`:

```ts
import { Reflector } from '@nestjs/core';
import { ThrottlerModule, ThrottlerOptions } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from '../config';
import { IS_COSTLY } from './costly.decorator';

export const WINDOW_MS = 60_000;

/** A tier set to 0 is left out, so with both off the guard has nothing to count. */
export function buildThrottlers({ perMinute, costlyPerMinute }: AppConfig['rateLimit']): ThrottlerOptions[] {
  const reflector = new Reflector();
  const throttlers: ThrottlerOptions[] = [];
  // setHeaders is off: for a named throttler the library would send `Retry-After-costly`; the guard sends `Retry-After`.
  if (perMinute > 0) throttlers.push({ name: 'general', limit: perMinute, ttl: WINDOW_MS, setHeaders: false });
  if (costlyPerMinute > 0) {
    throttlers.push({
      name: 'costly',
      limit: costlyPerMinute,
      ttl: WINDOW_MS,
      setHeaders: false,
      skipIf: (context) => !reflector.getAllAndOverride<boolean>(IS_COSTLY, [context.getHandler(), context.getClass()]),
    });
  }
  return throttlers;
}

/** Counters are kept in memory by the library's default storage: per API process, reset on restart. */
export const RateLimitModule = ThrottlerModule.forRootAsync({
  inject: [APP_CONFIG],
  useFactory: (cfg: AppConfig) => ({
    throttlers: buildThrottlers(cfg.rateLimit),
    errorMessage: 'Too many requests. Slow down and try again shortly.',
  }),
});
```

- [ ] **Step 6: Implement the guard**

Create `apps/api/src/rate-limit/app-throttler.guard.ts`:

```ts
import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  normalizeIp,
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { IS_PUBLIC } from '../auth/public.decorator';
import { APP_CONFIG, AppConfig } from '../config';

/**
 * Must be registered after AuthGuard: with API keys the caller is the user it identified. Without
 * keys everyone is the same default user, so the client IP is the caller instead.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    @Inject(Reflector) reflector: Reflector,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {
    super(options, storageService, reflector);
  }

  protected async shouldSkip(context: ExecutionContext): Promise<boolean> {
    return !!this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    if (this.cfg.auth.keys.size > 0 && req.user?.id) return `user:${req.user.id}`;
    return `ip:${normalizeIp(req.ip ?? 'unknown', this.ipv6SubnetPrefix)}`;
  }

  /** One counter per tier and caller. The default key also includes the route, which would make every route its own bucket. */
  protected generateKey(_context: ExecutionContext, tracker: string, throttlerName: string): string {
    return `${throttlerName}:${tracker}`;
  }

  protected async throwThrottlingException(context: ExecutionContext, detail: ThrottlerLimitDetail): Promise<void> {
    const { res } = this.getRequestResponse(context);
    this.setResponseHeader(res, 'Retry-After', Math.max(1, detail.timeToBlockExpire));
    return super.throwThrottlingException(context, detail);
  }
}
```

- [ ] **Step 7: Implement `configureApp` and use it in `main.ts`**

Create `apps/api/src/app.setup.ts`:

```ts
import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ProviderErrorFilter } from './common/provider-error.filter';
import { AppConfig } from './config';

/**
 * Document text is capped at 500,000 characters, and JSON escaping can turn one character into six
 * bytes, so Express's 100 kB default would reject documents the API otherwise accepts.
 */
export const JSON_BODY_LIMIT = '4mb';

/** Everything main.ts sets up, shared with the tests so they run the same configuration. */
export function configureApp(app: NestExpressApplication, cfg: AppConfig): void {
  app.enableCors({
    origin: cfg.corsOrigin.split(',').map((o) => o.trim()),
    // Browsers hide other response headers from scripts; the web app shows "try again in N seconds".
    exposedHeaders: ['Retry-After'],
  });
  // Trust no proxy unless told to: otherwise anyone could pick their own IP with X-Forwarded-For.
  app.set('trust proxy', cfg.trustProxy);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ProviderErrorFilter());
}
```

Replace the body of `bootstrap()` in `apps/api/src/main.ts` up to `app.enableShutdownHooks()` with:

```ts
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const cfg = app.get<AppConfig>(APP_CONFIG);

  configureApp(app, cfg);
  app.enableShutdownHooks();
```

and fix the imports (`NestExpressApplication` from `@nestjs/platform-express`, `configureApp` from `./app.setup`; drop the now-unused `ValidationPipe` and `ProviderErrorFilter` imports).

- [ ] **Step 8: Run the new tests and watch them pass**

Run: `npm test -w apps/api -- rate-limit.spec body-limit`
Expected: PASS. If `useBodyParser` is rejected because the app was created with the default body parser, check the NestJS docs for the installed version and adapt `configureApp` (the body-limit test is the proof either way).

- [ ] **Step 9: Typecheck and commit**

Run: `npm run typecheck -w apps/api`
Expected: no errors.

```bash
git add apps/api package-lock.json
git commit -m "Add throttler guard, costly tier decorator and shared app setup

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Wire into the app and mark the costly routes

**Files:**
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/query/query.controller.ts`, `apps/api/src/documents/documents.controller.ts`, `apps/api/src/jobs/jobs.controller.ts`
- Modify: `apps/api/test/api.e2e.spec.ts` (switch limits off in its setup)
- Test: `apps/api/test/costly-routes.spec.ts`, `apps/api/test/rate-limit.e2e.spec.ts`

**Interfaces:**
- Consumes: `Costly`, `RateLimitModule`, `AppThrottlerGuard`, `configureApp` (Task 2).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/costly-routes.spec.ts`:

```ts
import 'reflect-metadata';
import { DocumentsController } from '../src/documents/documents.controller';
import { JobsController } from '../src/jobs/jobs.controller';
import { QueryController } from '../src/query/query.controller';
import { IS_COSTLY } from '../src/rate-limit/costly.decorator';

const costly = (controller: { prototype: object }, handler: string): boolean =>
  !!Reflect.getMetadata(IS_COSTLY, (controller.prototype as Record<string, object>)[handler]);

describe('which routes are costly', () => {
  it.each([
    [QueryController, 'ask'],
    [QueryController, 'stream'],
    [DocumentsController, 'create'],
    [DocumentsController, 'upload'],
    [DocumentsController, 'reindexAll'],
    [DocumentsController, 'update'],
    [DocumentsController, 'reindex'],
    [JobsController, 'indexText'],
    [JobsController, 'upload'],
    [JobsController, 'reindexAll'],
  ])('%p.%s calls a model and is marked @Costly()', (controller, handler) => {
    expect(costly(controller as never, handler)).toBe(true);
  });

  it.each([
    [DocumentsController, 'list'],
    [DocumentsController, 'get'],
    [DocumentsController, 'remove'],
    [JobsController, 'list'],
    [JobsController, 'get'],
  ])('%p.%s is a cheap route', (controller, handler) => {
    expect(costly(controller as never, handler)).toBe(false);
  });
});
```

Create `apps/api/test/rate-limit.e2e.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm test -w apps/api -- costly-routes`
Expected: FAIL (the ten costly handlers have no metadata).

Run: `E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_test npm test -w apps/api -- rate-limit.e2e`
Expected: FAIL (the 4th query is not limited yet).

- [ ] **Step 3: Mark the routes**

Add `import { Costly } from '../rate-limit/costly.decorator';` to each controller and add `@Costly()` directly above the route decorator of:
- `query.controller.ts`: `ask` (`@Post()`), `stream` (`@Post('stream')`)
- `documents.controller.ts`: `create` (`@Post()`), `upload`, `reindexAll`, `update` (`@Put(':id')`), `reindex` (`@Post(':id/reindex')`)
- `jobs.controller.ts`: `indexText`, `upload`, `reindexAll`

- [ ] **Step 4: Wire the module and guard**

In `apps/api/src/app.module.ts` add imports for `AppThrottlerGuard` and `RateLimitModule`, add `RateLimitModule` to `imports` (after `DatabaseModule`), and replace `providers` with:

```ts
  // Order matters: AuthGuard identifies the user first, then the limiter counts that user.
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
```

- [ ] **Step 5: Keep the existing e2e suite out of the limiter**

In `apps/api/test/api.e2e.spec.ts`, add to the `Object.assign(process.env, {...})` in `beforeAll`:

```ts
      // This suite makes hundreds of calls from one address; rate limiting has its own spec.
      RATE_LIMIT_PER_MIN: '0',
      RATE_LIMIT_COSTLY_PER_MIN: '0',
```

- [ ] **Step 6: Run the focused tests, then the whole suite**

Run: `npm test -w apps/api -- costly-routes`
Expected: PASS.

Run: `E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_test npm test`
Expected: all suites PASS (the database container from earlier work must be running; start it with `docker compose up -d db` if not).

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "Apply rate limits to the real routes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web app shows a readable rate-limit message

**Files:**
- Modify: `apps/web/lib/api.ts`

**Interfaces:**
- Consumes: the API's `429` with `Retry-After` (exposed to browsers by Task 2).
- Produces: `RateLimitError` (exported, extends `Error`) thrown by both the JSON and stream request paths.

`apps/web` has no test runner, so this task is verified by typecheck and a manual check (Step 3).

- [ ] **Step 1: Implement**

In `apps/web/lib/api.ts`, after the `AuthError` class add:

```ts
/** The API refused the request because this caller sent too many. */
export class RateLimitError extends Error {}

function rateLimited(res: Response): RateLimitError {
  const seconds = Number(res.headers.get('retry-after'));
  const wait = Number.isFinite(seconds) && seconds > 0 ? `Try again in ${Math.ceil(seconds)} seconds.` : 'Try again shortly.';
  return new RateLimitError(`Too many requests. ${wait}`);
}
```

In `request()`, directly after the `401` line, add `if (res.status === 429) throw rateLimited(res);`. In the stream function, directly after its `401` line, add the same line.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w apps/web`
Expected: no errors. If the script is named differently, run `npx tsc --noEmit -p apps/web`.

- [ ] **Step 3: Manual check**

Run the API with `RATE_LIMIT_COSTLY_PER_MIN=2` (`npm run dev`), open the web app, ask three questions in a row.
Expected: the third shows "Too many requests. Try again in N seconds." instead of "Request failed (429)". Say in the PR that this step was manual.

- [ ] **Step 4: Commit**

```bash
git add apps/web/lib/api.ts
git commit -m "Show a readable message when the API rate-limits the web app

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentation and TODO

**Files:**
- Modify: `README.md`, `.env.example`, `TODO.md`
- Modify: `docs/superpowers/specs/2026-10-24-rate-limiting-design.md` (amend with the plan's rulings)

- [ ] **Step 1: `.env.example`**

Add after the `API_KEYS=` block (before "Background ingestion jobs"):

```
# Rate limits per caller (the user when API_KEYS is set, otherwise the client IP), per minute.
# Costly routes (queries and anything that embeds) also count against the lower limit. 0 = no limit.
# Counters are kept in this process's memory: they reset on restart, and N API instances allow N times the limit.
RATE_LIMIT_PER_MIN=300
RATE_LIMIT_COSTLY_PER_MIN=20

# Behind a reverse proxy, set this so clients are told apart by their real IP: `true`, or the number of
# proxies in front of the API. Leave it unset when the API is reached directly; otherwise anyone could
# choose their own IP with the X-Forwarded-For header. Forgetting it behind a proxy makes everyone share
# the proxy's limit.
TRUST_PROXY=false
```

- [ ] **Step 2: README**

Directly after the authentication notes (the bullets ending "...partition the table by owner instead.", around line 190), add a section:

```markdown
### Rate limits

Every call to a model costs money, so requests are limited per caller: the user when `API_KEYS` is set, otherwise the client IP. Two limits apply, each over a 60-second window:

- `RATE_LIMIT_PER_MIN` (default 300) counts every request except `/health`.
- `RATE_LIMIT_COSTLY_PER_MIN` (default 20) also counts the routes that call a model: asking questions (`/query`, `/query/stream`) and everything that embeds (creating, updating, uploading and re-indexing documents, including the `/jobs` versions).

Over the limit, the API answers `429` with a `Retry-After` header (seconds), and the web app says how long to wait. `0` turns a limit off.

Known limits: counters live in the API process's memory, so they reset on restart, and running several API instances multiplies the limit. Wrong API keys are rejected before the limiter and are not counted (keys are at least 16 characters). Behind a reverse proxy set `TRUST_PROXY` (see `.env.example`), or every client shares the proxy's address. For a public deployment, also set a spend cap at your model provider as a backstop.
```

- [ ] **Step 3: Amend the spec**

In `docs/superpowers/specs/2026-10-24-rate-limiting-design.md`:
- Under "Response", replace the sentence that `Retry-After` is "provided by the throttler" with: the library names the header `Retry-After-<throttler>` for named throttlers, so the guard sets `Retry-After` itself; CORS `exposedHeaders: ['Retry-After']` lets the browser read it.
- Under "Who is a caller", add: counters are keyed by tier and caller (not by route), and IPv6 addresses are grouped by /64.
- Under "Components", add `apps/api/src/app.setup.ts` (`configureApp`, shared by `main.ts` and the tests).
- Change the status line to "Implemented; see the plan for the rulings made on the way."

- [ ] **Step 4: TODO**

In `TODO.md`, tick the rate-limiting item (`- [x]`) and replace its trailing "Spec:" sentence with a short note: "Two tiers (general, costly) per user or IP, in memory; explicit JSON body limit."

- [ ] **Step 5: Final verification**

Run: `npm run typecheck -w apps/api && E2E_DATABASE_URL=postgres://rag:rag@localhost:5433/rag_test npm test`
Expected: typecheck clean and all suites PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md .env.example TODO.md docs/superpowers/specs/2026-10-24-rate-limiting-design.md
git commit -m "Document rate limits; tick the TODO item

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```
