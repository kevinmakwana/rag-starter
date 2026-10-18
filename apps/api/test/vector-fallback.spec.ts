import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { MockChatProvider, MockEmbeddingProvider } from '../src/providers/mock.provider';
import { QueryService } from '../src/query/query.service';

const row = (id: string, score = 0.9) => ({
  chunkId: id,
  documentId: '00000000-0000-0000-0000-000000000000',
  title: 'Doc',
  heading: id,
  content: id,
  score,
});

/** Answers the first (index) query and any later (exact) query from two canned lists. */
function setup(indexed: ReturnType<typeof row>[], exact: ReturnType<typeof row>[]) {
  const sqls: string[] = [];
  const db = {
    query: async (sql: string) => {
      sqls.push(sql);
      return { rows: sqls.length === 1 ? indexed : exact };
    },
  } as any;
  const cfg = { topK: 5, minScore: 0.1, historyMessages: 0, searchMode: 'vector' } as AppConfig;
  return { sqls, service: new QueryService(cfg, new MockEmbeddingProvider(64), new MockChatProvider(), db) };
}

/** The plain form is the only ORDER BY that lets Postgres use the HNSW index. */
const usesIndexOrdering = (sql: string) => /ORDER BY c\.embedding <=> \$1::vector\s+LIMIT/.test(sql);

describe('vector search safety net', () => {
  it('asks the HNSW index first and stops there when it returns enough rows', async () => {
    const { service, sqls } = setup([row('a'), row('b'), row('c')], []);

    const chunks = await service.retrieve('q', 3);

    expect(chunks.map((c) => c.chunkId)).toEqual(['a', 'b', 'c']);
    expect(sqls).toHaveLength(1);
    expect(usesIndexOrdering(sqls[0])).toBe(true);
  });

  it('re-runs as an exact scan when the index comes back short, e.g. starved by deleted entries', async () => {
    const { service, sqls } = setup([row('a')], [row('a'), row('b'), row('c')]);

    const chunks = await service.retrieve('q', 3);

    expect(chunks.map((c) => c.chunkId)).toEqual(['a', 'b', 'c']);
    expect(sqls).toHaveLength(2);
    expect(usesIndexOrdering(sqls[1])).toBe(false);
  });

  it('falls back when the index returns nothing at all', async () => {
    const { service } = setup([], [row('a'), row('b')]);
    expect((await service.retrieve('q', 3)).map((c) => c.chunkId)).toEqual(['a', 'b']);
  });

  it('gives the same answer either way when the table really has fewer rows than asked for', async () => {
    const { service } = setup([row('a')], [row('a')]);
    expect((await service.retrieve('q', 3)).map((c) => c.chunkId)).toEqual(['a']);
  });
});

describe('exact search for small corpora', () => {
  /** Reports `estimate` chunks to the size check; everything else is answered from canned lists. */
  function sized(estimate: number, max: number | undefined, indexed: ReturnType<typeof row>[], exact = indexed) {
    const sqls: string[] = [];
    const db = {
      query: async (sql: string) => {
        sqls.push(sql);
        if (/pg_class/.test(sql)) return { rows: [{ estimate }] };
        return { rows: usesIndexOrdering(sql) ? indexed : exact };
      },
    } as any;
    const cfg = { topK: 5, minScore: 0.1, historyMessages: 0, searchMode: 'vector', exactSearchMaxChunks: max } as AppConfig;
    return { sqls, service: new QueryService(cfg, new MockEmbeddingProvider(64), new MockChatProvider(), db) };
  }

  it('skips the approximate index entirely when the table is small, even if the index would look fine', async () => {
    // A degraded index can return a full page of rows that are not the true nearest, so size, not row count, decides.
    const { service, sqls } = sized(500, 20_000, [row('wrong1'), row('wrong2'), row('wrong3')], [row('right1'), row('right2'), row('right3')]);

    const chunks = await service.retrieve('q', 3);

    expect(chunks.map((c) => c.chunkId)).toEqual(['right1', 'right2', 'right3']);
    expect(sqls.filter((s) => !/pg_class/.test(s)).every((s) => !usesIndexOrdering(s))).toBe(true);
  });

  it('uses the HNSW index above the size limit, with the short-result fallback still in place', async () => {
    const { service, sqls } = sized(50_000, 20_000, [row('a'), row('b'), row('c')]);

    expect((await service.retrieve('q', 3)).map((c) => c.chunkId)).toEqual(['a', 'b', 'c']);
    expect(sqls.filter((s) => !/pg_class/.test(s))).toHaveLength(1);
  });

  it('treats a table Postgres has never analysed (reltuples = -1) as small', async () => {
    const { service, sqls } = sized(-1, 20_000, [row('wrong')], [row('right')]);
    expect((await service.retrieve('q', 1)).map((c) => c.chunkId)).toEqual(['right']);
    expect(sqls.some((s) => usesIndexOrdering(s))).toBe(false);
  });

  it('is off when the limit is 0 or unset, always using the index', async () => {
    for (const max of [0, undefined]) {
      const { service, sqls } = sized(10, max, [row('a'), row('b')]);
      await service.retrieve('q', 2);
      expect(sqls.some((s) => /pg_class/.test(s))).toBe(false);
    }
  });
});
