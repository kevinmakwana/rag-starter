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
