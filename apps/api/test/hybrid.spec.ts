import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { MockChatProvider, MockEmbeddingProvider } from '../src/providers/mock.provider';
import { QueryService } from '../src/query/query.service';
import { reciprocalRankFusion, toOrTsQuery } from '../src/query/search';

describe('toOrTsQuery', () => {
  it('ORs the words of a question so one missing word does not rule a passage out', () => {
    expect(toOrTsQuery('How does billing work?')).toBe('how | does | billing | work');
  });

  it('strips characters that are special in tsquery syntax', () => {
    expect(toOrTsQuery("it's (AES-256) & TLS 1.2: ok!")).toBe("it | s | aes | 256 | tls | 1 | 2 | ok");
  });

  it('returns an empty string when there is nothing searchable', () => {
    expect(toOrTsQuery('?! ...')).toBe('');
  });
});

describe('reciprocalRankFusion', () => {
  const item = (id: string) => ({ chunkId: id });

  it('ranks items that appear high in several lists first', () => {
    const fused = reciprocalRankFusion([[item('a'), item('b'), item('c')], [item('c'), item('b'), item('d')]]);
    expect(fused.map((f) => f.item.chunkId)).toEqual(['c', 'b', 'a', 'd']); // c: 1/63 + 1/61 narrowly beats b: 1/62 + 1/62
  });

  it('keeps an item that only one list found', () => {
    const fused = reciprocalRankFusion([[item('a')], [item('z')]]);
    expect(fused.map((f) => f.item.chunkId).sort()).toEqual(['a', 'z']);
  });

  it('scores 1/(k+rank) per list, summed', () => {
    const [top] = reciprocalRankFusion([[item('a')], [item('a')]], 60);
    expect(top.score).toBeCloseTo(2 / 61, 10);
  });

  it('returns nothing for no input', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});

describe('QueryService.retrieve in hybrid mode', () => {
  const row = (id: string, score: number) => ({
    chunkId: id,
    documentId: '00000000-0000-0000-0000-000000000000',
    title: 'Doc',
    heading: id,
    content: id,
    score,
  });

  /** A db that answers the vector query and the full-text query from canned lists. */
  function fakeDb(vector: ReturnType<typeof row>[], lexical: ReturnType<typeof row>[]) {
    const queries: string[] = [];
    return {
      queries,
      query: async (sql: string) => {
        queries.push(/ts_rank|@@/.test(sql) ? 'lexical' : 'vector');
        return { rows: /ts_rank|@@/.test(sql) ? lexical : vector };
      },
    } as any;
  }

  const service = (searchMode: 'vector' | 'hybrid', db: any, minScore = 0.1) =>
    new QueryService(
      { topK: 5, minScore, historyMessages: 0, searchMode } as AppConfig,
      new MockEmbeddingProvider(64),
      new MockChatProvider(),
      db,
    );

  it('does not touch full-text search in vector mode', async () => {
    const db = fakeDb([row('a', 0.9)], [row('b', 0.8)]);
    const chunks = await service('vector', db).retrieve('question', 5);
    expect(new Set(db.queries)).toEqual(new Set(['vector'])); // (may repeat as an exact scan when short)
    expect(chunks.map((c) => c.chunkId)).toEqual(['a']);
  });

  it('breaks full-text ties by chunk id so identical questions always rank the same way', async () => {
    const sqls: string[] = [];
    const db = {
      query: async (sql: string) => {
        sqls.push(sql);
        return { rows: [] };
      },
    } as any;

    await service('hybrid', db).retrieve('data encrypted', 5);

    const lexical = sqls.find((sql) => /ts_rank_cd/.test(sql))!;
    // Postgres returns tied rows in physical order, which shifts as rows are rewritten.
    expect(lexical).toMatch(/ORDER BY ts_rank_cd\([^)]*\)[^)]*\) DESC,\s*c\.id/);
  });

  it('surfaces a passage that only full-text search ranked well', async () => {
    const db = fakeDb([row('a', 0.9), row('b', 0.5)], [row('c', 0.4), row('b', 0.5)]);
    const chunks = await service('hybrid', db).retrieve('exact-term-123', 5);

    expect(new Set(db.queries)).toEqual(new Set(['lexical', 'vector']));
    expect(chunks.map((c) => c.chunkId)).toEqual(['b', 'a', 'c']); // b is in both lists, so it leads
  });

  it('still drops passages below the similarity threshold, so unanswerable questions find nothing', async () => {
    const db = fakeDb([row('a', 0.05)], [row('c', 0.02)]);
    expect(await service('hybrid', db, 0.1).retrieve('capital of france', 5)).toEqual([]);
  });

  it('limits the result to topK', async () => {
    const many = Array.from({ length: 8 }, (_, i) => row(`v${i}`, 0.9 - i * 0.01));
    const chunks = await service('hybrid', fakeDb(many, []), 0.1).retrieve('q', 3);
    expect(chunks).toHaveLength(3);
  });

  it('reports the cosine score, not the fused score', async () => {
    const [top] = await service('hybrid', fakeDb([row('a', 0.77)], [row('a', 0.77)])).retrieve('q', 5);
    expect(top.score).toBe(0.77);
  });
});
