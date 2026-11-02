import 'reflect-metadata';
import { Controller, Delete, Get, INestApplication, Module, Post, Put } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'net';
import { configureApp } from '../src/app.setup';
import { hashKey } from '../src/auth/api-keys';
import { AuthGuard } from '../src/auth/auth.guard';
import { Public } from '../src/auth/public.decorator';
import { APP_CONFIG, AppConfig } from '../src/config';
import { DemoBudgetGuard, DemoModeGuard } from '../src/demo/demo-mode.guard';
import { DemoSafe } from '../src/demo/demo-safe.decorator';
import { Costly } from '../src/rate-limit/costly.decorator';
import { RateLimitGuard } from '../src/rate-limit/rate-limit.guard';

@Controller()
class Probe {
  @Get('read')
  read() {
    return { ok: true };
  }

  @DemoSafe()
  @Costly()
  @Post('ask')
  ask() {
    return { ok: true };
  }

  // No marker of any kind: stands for "a write route somebody adds next year".
  @Post('write')
  create() {
    return { ok: true };
  }

  @Put('write')
  update() {
    return { ok: true };
  }

  @Delete('write')
  remove() {
    return { ok: true };
  }

  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }
}

/** @DemoSafe() on a whole class is a mistake that must not open its write routes: only a handler can be safe. */
@DemoSafe()
@Controller('classlevel')
class ClassLevelProbe {
  @Post('write')
  create() {
    return { ok: true };
  }
}

const ALICE = 'alice-key-0123456789';
const BOB = 'bobs-key-abcdefghijk';
const CAROL = 'carol-key-zyxwvutsrq';
const as = (key: string) => ({ authorization: `Bearer ${key}` });

interface Options {
  demo?: boolean;
  cap?: number;
  perMinute?: number;
  costly?: number;
  keys?: Record<string, string>;
}

describe('demo mode guards', () => {
  const apps: INestApplication[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function start(over: Options = {}) {
    const cfg = {
      corsOrigin: 'http://localhost:3000',
      trustProxy: false,
      auth: { keys: new Map(Object.entries(over.keys ?? {}).map(([key, user]) => [hashKey(key), user])) },
      rateLimit: { perMinute: over.perMinute ?? 0, costlyPerMinute: over.costly ?? 0 },
      demo: { enabled: over.demo ?? true, maxQueriesPerDay: over.cap ?? 0 },
    } as unknown as AppConfig;

    @Module({
      imports: [
        { module: class ConfigModule {}, global: true, providers: [{ provide: APP_CONFIG, useValue: cfg }], exports: [APP_CONFIG] },
      ],
      controllers: [Probe, ClassLevelProbe],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: DemoModeGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_GUARD, useClass: DemoBudgetGuard },
      ],
    })
    class TestModule {}

    const app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    configureApp(app, cfg);
    await app.listen(0);
    apps.push(app);
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    return (method: string, path: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${path}`, { method, headers: { connection: 'close', ...headers } });
  }

  it('lets visitors read, ask, and reach public routes', async () => {
    const call = await start();

    expect((await call('GET', '/read')).status).toBe(200);
    expect((await call('HEAD', '/read')).status).toBe(200);
    expect((await call('POST', '/ask')).status).toBe(201);
    expect((await call('GET', '/health')).status).toBe(200);
    expect((await call('OPTIONS', '/write')).status).toBeLessThan(400); // CORS preflight
  });

  it('refuses every other write with 403 and a clear message, including a route nobody classified', async () => {
    const call = await start();

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const res = await call(method, '/write');
      expect([method, res.status]).toEqual([method, 403]);
      expect(await res.json()).toMatchObject({
        statusCode: 403,
        message: 'This is a read-only demo: uploading, editing and deleting are turned off.',
      });
    }
  });

  it('does not let @DemoSafe() on a whole class open its other routes: only a handler can be marked', async () => {
    const call = await start({ cap: 1 });

    expect((await call('POST', '/classlevel/write')).status).toBe(403);
    expect((await call('POST', '/ask')).status).toBe(201); // and a marked handler is still the way in
  });

  it('changes nothing when demo mode is off', async () => {
    const call = await start({ demo: false, cap: 1 });

    expect((await call('POST', '/write')).status).toBe(201);
    expect((await call('PUT', '/write')).status).toBe(200);
    expect((await call('DELETE', '/write')).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await call('POST', '/ask')).status).toBe(201); // no daily cap either
  });

  it('asks for the API key before it explains the demo, when keys are configured too', async () => {
    const call = await start({ keys: { [ALICE]: 'alice' } });

    expect((await call('POST', '/write')).status).toBe(401);
    expect((await call('POST', '/write', as(ALICE))).status).toBe(403);
  });

  it('does not let refused writes spend the rate-limit budget', async () => {
    const call = await start({ perMinute: 2 });

    for (let i = 0; i < 5; i++) expect((await call('POST', '/write')).status).toBe(403);

    expect((await call('GET', '/read')).status).toBe(200);
    expect((await call('GET', '/read')).status).toBe(200);
    expect((await call('GET', '/read')).status).toBe(429);
  });

  it("answers 429 with Retry-After once the daily cap is used up, in words that are not the rate limiter's", async () => {
    const call = await start({ cap: 2 });
    await call('POST', '/ask');
    await call('POST', '/ask');

    const res = await call('POST', '/ask');

    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(86_400);
    expect(((await res.json()) as { message: string }).message).toBe(
      "The demo has reached today's question limit. Please try again tomorrow.",
    );
  });

  it('counts only questions: reads and refused writes leave the daily budget alone', async () => {
    const call = await start({ cap: 1 });

    for (let i = 0; i < 3; i++) expect((await call('GET', '/read')).status).toBe(200);
    expect((await call('POST', '/write')).status).toBe(403);

    expect((await call('POST', '/ask')).status).toBe(201);
    expect((await call('POST', '/ask')).status).toBe(429);
  });

  it('does not let rate-limited requests spend the daily budget', async () => {
    const call = await start({ costly: 1, cap: 2, keys: { [ALICE]: 'alice', [BOB]: 'bob', [CAROL]: 'carol' } });

    expect((await call('POST', '/ask', as(ALICE))).status).toBe(201); // daily budget: 1 of 2
    const limited = await call('POST', '/ask', as(ALICE));
    expect(limited.status).toBe(429); // the rate limiter, not the daily cap
    expect(((await limited.json()) as { message: string }).message).toMatch(/Slow down/);

    expect((await call('POST', '/ask', as(BOB))).status).toBe(201); // daily budget: 2 of 2, so the refused call did not count
    const exhausted = await call('POST', '/ask', as(CAROL));
    expect(exhausted.status).toBe(429);
    expect(((await exhausted.json()) as { message: string }).message).toMatch(/today's question limit/);
  });

  it('has no daily cap when the cap is 0', async () => {
    const call = await start({ cap: 0 });

    for (let i = 0; i < 10; i++) expect((await call('POST', '/ask')).status).toBe(201);
  });
});
