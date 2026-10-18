import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { MockEmbeddingProvider } from '../src/providers/mock.provider';
import { ChatProvider } from '../src/providers/types';
import { QueryService } from '../src/query/query.service';

const row = {
  chunkId: '1',
  documentId: '00000000-0000-0000-0000-000000000000',
  title: 'Doc',
  heading: 'Backups',
  content: 'Backups are kept for 30 days.',
  score: 0.9,
};

function serviceAnswering(answer: string, rows: unknown[] = [row]) {
  const chat: ChatProvider = { name: 'fake', complete: async () => answer, async *stream() { yield answer; } };
  const db = { query: async () => ({ rows }) } as any;
  const cfg = { topK: 5, minScore: 0, historyMessages: 0, searchMode: 'vector' } as AppConfig;
  return new QueryService(cfg, new MockEmbeddingProvider(64), chat, db);
}

describe('citation flagging', () => {
  it('flags an answer that cites nothing although passages were retrieved', async () => {
    const result = await serviceAnswering('Backups are kept for 30 days.').ask('How long are backups kept?');
    expect(result.meta.citationsMissing).toBe(true);
    expect(result.sources[0].cited).toBe(false);
  });

  it('does not flag an answer with a valid citation, in any supported form', async () => {
    for (const answer of ['Kept 30 days [1].', 'Kept 30 days [1, 2].', 'Kept 30 days [1-1].']) {
      const result = await serviceAnswering(answer).ask('q');
      expect(result.meta.citationsMissing).toBeUndefined();
      expect(result.sources[0].cited).toBe(true);
    }
  });

  it('flags citations that point at passages that do not exist', async () => {
    const result = await serviceAnswering('Kept 30 days [7].').ask('q');
    expect(result.meta.citationsMissing).toBe(true);
  });

  it('does not flag a refusal, which legitimately cites nothing', async () => {
    const result = await serviceAnswering("I don't know based on the provided documents.").ask('q');
    expect(result.meta.citationsMissing).toBeUndefined();
  });

  it('does not flag the no-context answer', async () => {
    const result = await serviceAnswering('unused', []).ask('q');
    expect(result.meta.citationsMissing).toBeUndefined();
  });

  it('reports it for streamed answers too', async () => {
    const events = [];
    for await (const event of serviceAnswering('Kept 30 days.').askStream('q')) events.push(event);
    const done = events[events.length - 1] as any;
    expect(done.result.meta.citationsMissing).toBe(true);
  });
});
