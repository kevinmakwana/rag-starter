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
