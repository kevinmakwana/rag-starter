import { loadConfig } from '../src/config';

describe('loadConfig for demo mode', () => {
  const KEYS = ['DEMO_MODE', 'DEMO_MAX_QUERIES_PER_DAY'];
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

  it('is off by default, with a daily cap of 500 ready for when it is turned on', () => {
    expect(loadConfig().demo).toEqual({ enabled: false, maxQueriesPerDay: 500 });
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['false', false],
    ['', false],
  ])('reads DEMO_MODE=%p as %p', (raw, expected) => {
    process.env.DEMO_MODE = raw;
    expect(loadConfig().demo.enabled).toBe(expected);
  });

  it.each(['yes', '1', 'on'])('rejects DEMO_MODE=%s, naming the variable', (value) => {
    process.env.DEMO_MODE = value;
    expect(() => loadConfig()).toThrow(/DEMO_MODE/);
  });

  it('reads DEMO_MAX_QUERIES_PER_DAY, where 0 means no cap', () => {
    process.env.DEMO_MAX_QUERIES_PER_DAY = '120';
    expect(loadConfig().demo.maxQueriesPerDay).toBe(120);
    process.env.DEMO_MAX_QUERIES_PER_DAY = '0';
    expect(loadConfig().demo.maxQueriesPerDay).toBe(0);
  });

  it.each(['-1', '1.5', 'lots'])('rejects DEMO_MAX_QUERIES_PER_DAY=%s, naming the variable', (value) => {
    process.env.DEMO_MAX_QUERIES_PER_DAY = value;
    expect(() => loadConfig()).toThrow(/DEMO_MAX_QUERIES_PER_DAY/);
  });
});
