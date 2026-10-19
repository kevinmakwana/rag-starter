import 'reflect-metadata';
import { ExecutionContext, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppConfig } from '../src/config';
import { AuthGuard } from '../src/auth/auth.guard';
import { hashKey, parseApiKeys } from '../src/auth/api-keys';
import { DEFAULT_OWNER, IS_PUBLIC } from '../src/auth/public.decorator';

const KEY_A = 'alice-key-0123456789';
const KEY_B = 'bobs-key-abcdefghijk';

describe('parseApiKeys', () => {
  it('returns nothing when unset or blank, which means authentication is off', () => {
    expect(parseApiKeys(undefined)).toEqual([]);
    expect(parseApiKeys('')).toEqual([]);
    expect(parseApiKeys('  ,  ')).toEqual([]);
  });

  it('reads key:user pairs, trimming whitespace', () => {
    expect(parseApiKeys(` ${KEY_A}:alice , ${KEY_B}:bob `)).toEqual([
      { key: KEY_A, user: 'alice' },
      { key: KEY_B, user: 'bob' },
    ]);
  });

  it('lets one user have several keys, for rotation', () => {
    expect(parseApiKeys(`${KEY_A}:alice,${KEY_B}:alice`).map((k) => k.user)).toEqual(['alice', 'alice']);
  });

  it.each([
    ['a pair without a user', KEY_A],
    ['an empty user', `${KEY_A}:`],
    ['a key that is too short to be safe', 'short:alice'],
    ['a user name with spaces', `${KEY_A}:Alice Smith`],
    ['the same key twice', `${KEY_A}:alice,${KEY_A}:bob`],
  ])('rejects %s, naming API_KEYS', (_label, raw) => {
    expect(() => parseApiKeys(raw)).toThrow(/API_KEYS/);
  });

  it('never echoes a key in its error messages', () => {
    for (const raw of ['short:alice', `${KEY_A}:Alice Smith`]) {
      try {
        parseApiKeys(raw);
      } catch (err) {
        expect((err as Error).message).not.toContain(KEY_A);
        expect((err as Error).message).not.toContain('short:');
      }
    }
  });
});

describe('AuthGuard', () => {
  class Controller {
    @SetMetadata(IS_PUBLIC, true)
    open() {}
    closed() {}
  }

  const keys = (pairs: [string, string][]) => new Map(pairs.map(([key, user]) => [hashKey(key), user]));

  function context(handler: () => void, headers: Record<string, string> = {}) {
    const request: any = { headers };
    const ctx = {
      getHandler: () => handler,
      getClass: () => Controller,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { ctx, request };
  }

  const guard = (pairs: [string, string][]) =>
    new AuthGuard({ auth: { keys: keys(pairs) } } as unknown as AppConfig, new Reflector());

  const instance = new Controller();

  it('lets everyone in as the default user when no keys are configured', () => {
    const { ctx, request } = context(instance.closed);
    expect(guard([]).canActivate(ctx)).toBe(true);
    expect(request.user).toEqual({ id: DEFAULT_OWNER });
  });

  it('accepts a Bearer key and attaches its user', () => {
    const { ctx, request } = context(instance.closed, { authorization: `Bearer ${KEY_A}` });
    expect(guard([[KEY_A, 'alice']]).canActivate(ctx)).toBe(true);
    expect(request.user).toEqual({ id: 'alice' });
  });

  it('accepts the key in X-API-Key too', () => {
    const { ctx, request } = context(instance.closed, { 'x-api-key': KEY_B });
    expect(guard([[KEY_A, 'alice'], [KEY_B, 'bob']]).canActivate(ctx)).toBe(true);
    expect(request.user).toEqual({ id: 'bob' });
  });

  it.each([
    ['no credentials', {}],
    ['an unknown key', { authorization: 'Bearer nope-nope-nope-nope-nope' }],
    ['the wrong scheme', { authorization: `Basic ${KEY_A}` }],
    ['an empty bearer token', { authorization: 'Bearer ' }],
    ['a key of the wrong length', { 'x-api-key': KEY_A.slice(0, 5) }],
  ])('rejects %s with 401', (_label, headers) => {
    const { ctx, request } = context(instance.closed, headers as Record<string, string>);
    expect(() => guard([[KEY_A, 'alice']]).canActivate(ctx)).toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('leaves routes marked public open, even with keys configured', () => {
    const { ctx } = context(instance.open);
    expect(guard([[KEY_A, 'alice']]).canActivate(ctx)).toBe(true);
  });
});
