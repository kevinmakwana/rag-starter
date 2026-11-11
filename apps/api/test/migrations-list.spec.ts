import { Migration, validateMigrations } from '../src/database/migrator';
import { migrations } from '../src/database/migrations';

const m = (id: number, name: string): Migration => ({ id, name, up: async () => undefined });

describe('validateMigrations', () => {
  it('accepts ids 1..n in order', () => {
    expect(() => validateMigrations([m(1, 'a'), m(2, 'b')])).not.toThrow();
    expect(() => validateMigrations([])).not.toThrow();
  });

  it('rejects a gap, a duplicate id, or the wrong order', () => {
    expect(() => validateMigrations([m(1, 'a'), m(3, 'c')])).toThrow(/1, 2, 3/);
    expect(() => validateMigrations([m(1, 'a'), m(1, 'b')])).toThrow(/1, 2, 3/);
    expect(() => validateMigrations([m(2, 'b'), m(1, 'a')])).toThrow(/1, 2, 3/);
    expect(() => validateMigrations([m(2, 'b')])).toThrow(/1, 2, 3/);
  });

  it('rejects an empty or repeated name', () => {
    expect(() => validateMigrations([m(1, '')])).toThrow(/name/);
    expect(() => validateMigrations([m(1, 'a'), m(2, 'a')])).toThrow(/same name/);
  });
});

it('the real migration list is valid and starts with the baseline', () => {
  expect(() => validateMigrations(migrations)).not.toThrow();
  expect(migrations[0]).toMatchObject({ id: 1, name: 'baseline' });
  expect(migrations[1]).toMatchObject({ id: 2, name: 'document_language' });
  expect(migrations[2]).toMatchObject({ id: 3, name: 'document_tags' });
});
