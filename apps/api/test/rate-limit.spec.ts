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
import { Costly } from '../src/rate-limit/costly.decorator';
import { RateLimitGuard } from '../src/rate-limit/rate-limit.guard';

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
      ],
      controllers: [Probe],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
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
    expect(((await limited.json()) as { statusCode: number }).statusCode).toBe(429);
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

  it("shares a user's budget across that user's keys and clients", async () => {
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

describe('RateLimitGuard caller', () => {
  const guard = (keys: [string, string][]) =>
    new RateLimitGuard(
      { auth: { keys: new Map(keys.map(([key, user]) => [hashKey(key), user])) } } as unknown as AppConfig,
      new Reflector(),
    ) as unknown as { callerOf(req: object): string };

  it('is the user id when authentication is on', () => {
    expect(guard([[ALICE, 'alice']]).callerOf({ user: { id: 'alice' }, ip: '9.9.9.9' })).toBe('user:alice');
  });

  it('is the client address when authentication is off, even though every request then has the default user', () => {
    expect(guard([]).callerOf({ user: { id: 'default' }, ip: '9.9.9.9' })).toBe('ip:9.9.9.9');
  });

  it('puts an IPv4 client reported as ::ffff:a.b.c.d in its own bucket, not one shared by every IPv4 client', () => {
    const g = guard([]);
    expect(g.callerOf({ ip: '::ffff:1.1.1.1' })).toBe('ip:1.1.1.1');
    expect(g.callerOf({ ip: '::ffff:2.2.2.2' })).not.toBe(g.callerOf({ ip: '::ffff:1.1.1.1' }));
  });
});
