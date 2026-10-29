import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { MockEmbeddingProvider } from '../src/providers/mock.provider';
import { ChatProvider } from '../src/providers/types';
import { QueryService } from '../src/query/query.service';

const cfg = { topK: 5, minScore: 0, historyMessages: 4 } as AppConfig;

describe('QueryService.askWithPassages', () => {
  // Longer than the 320 characters a source snippet is cut to.
  const content = 'Annual plans are billed once a year. '.repeat(20);
  const row = {
    chunkId: '1',
    documentId: '00000000-0000-0000-0000-000000000000',
    title: 'Pricing',
    heading: 'Billing',
    content,
    score: 0.8,
  };
  const db = { query: async () => ({ rows: [row] }) } as any;
  const chat: ChatProvider = {
    name: 'fake',
    async complete() {
      return 'Billed yearly [1].';
    },
    async *stream() {
      yield 'Billed yearly [1].';
    },
  };
  const service = new QueryService(cfg, new MockEmbeddingProvider(64), chat, db);

  it('returns the full passages, not the truncated snippets', async () => {
    const { result, passages } = await service.askWithPassages('How are annual plans billed?');

    expect(passages).toHaveLength(1);
    expect(passages[0].content).toBe(content);
    expect(result.sources[0].snippet.length).toBeLessThan(content.length);
    expect(result.sources.map((s) => s.documentId)).toEqual(passages.map((p) => p.documentId));
    expect(result.answer).toBe('Billed yearly [1].');
  });

  it('is what ask() returns, minus the passages', async () => {
    const asked = await service.askWithPassages('How are annual plans billed?');
    const plain = await service.ask('How are annual plans billed?');

    expect({ ...plain, meta: { ...plain.meta, tookMs: 0 } }).toEqual({
      ...asked.result,
      meta: { ...asked.result.meta, tookMs: 0 },
    });
  });

  it('returns no passages when nothing is retrieved', async () => {
    const empty = new QueryService(cfg, new MockEmbeddingProvider(64), chat, { query: async () => ({ rows: [] }) } as any);

    const { result, passages } = await empty.askWithPassages('anything');

    expect(passages).toEqual([]);
    expect(result.answer).toBe("I don't know based on the provided documents.");
  });
});
