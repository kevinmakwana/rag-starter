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
