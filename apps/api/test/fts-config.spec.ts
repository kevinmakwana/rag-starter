import { loadConfig } from '../src/config';

describe('loadConfig for FTS_LANGUAGE', () => {
  const saved = process.env.FTS_LANGUAGE;
  afterEach(() => (saved === undefined ? delete process.env.FTS_LANGUAGE : (process.env.FTS_LANGUAGE = saved)));

  it('defaults to english', () => {
    delete process.env.FTS_LANGUAGE;
    expect(loadConfig().ftsLanguage).toBe('english');
  });

  it('normalises case and surrounding spaces', () => {
    process.env.FTS_LANGUAGE = ' German ';
    expect(loadConfig().ftsLanguage).toBe('german');
  });

  it('rejects something that cannot be a configuration name, naming the variable', () => {
    process.env.FTS_LANGUAGE = 'english; drop table documents';
    expect(() => loadConfig()).toThrow(/FTS_LANGUAGE/);
  });
});
