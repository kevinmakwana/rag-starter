import { BadRequestException } from '@nestjs/common';
import { documentFilterSql, toInstant } from '../src/query/document-filter';

describe('documentFilterSql', () => {
  it('is empty without a filter', () => {
    expect(documentFilterSql(undefined, 'd', 4)).toEqual({ sql: '', params: [] });
    expect(documentFilterSql({}, 'd', 4)).toEqual({ sql: '', params: [] });
    expect(documentFilterSql({ documentIds: [], tags: [] }, 'd', 4)).toEqual({ sql: '', params: [] });
  });

  it('adds one numbered condition per filter, in a fixed order, starting at the given parameter', () => {
    const { sql, params } = documentFilterSql(
      {
        documentIds: ['id1'],
        tags: ['a'],
        source: 'x.md',
        createdAfter: '2026-01-01T00:00:00.000Z',
        createdBefore: '2026-02-01T00:00:00.000Z',
      },
      'd',
      4,
    );
    expect(sql).toBe(
      ' AND d.id = ANY($4::uuid[]) AND d.tags && $5::text[] AND d.source = $6' +
        ' AND d.created_at >= $7::timestamptz AND d.created_at < $8::timestamptz',
    );
    expect(params).toEqual([['id1'], ['a'], 'x.md', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
  });

  it('numbers from the first free parameter and skips the filters that are absent', () => {
    expect(documentFilterSql({ tags: ['a'] }, 'docs', 2)).toEqual({ sql: ' AND docs.tags && $2::text[]', params: [['a']] });
  });
});

describe('toInstant', () => {
  it('turns a date or a date-time into an ISO instant', () => {
    expect(toInstant('createdAfter', '2026-01-10')).toBe('2026-01-10T00:00:00.000Z');
    expect(toInstant('createdAfter', '2026-01-10T12:00:00+02:00')).toBe('2026-01-10T10:00:00.000Z');
    expect(toInstant('createdAfter', '2026-01-10T12:00:00Z')).toBe('2026-01-10T12:00:00.000Z');
  });

  it('answers 400 naming the field when the value is not a date', () => {
    expect(() => toInstant('createdBefore', 'yesterday')).toThrow(BadRequestException);
    expect(() => toInstant('createdBefore', 'yesterday')).toThrow(/createdBefore/);
  });
});
