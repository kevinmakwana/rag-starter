import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { MockChatProvider, MockEmbeddingProvider } from '../src/providers/mock.provider';
import { ChatMessage, ChatProvider } from '../src/providers/types';
import { RetrievedChunk } from '../src/query/prompt';
import { QueryService } from '../src/query/query.service';
import { LlmReranker, NoopReranker, Reranker } from '../src/query/reranker';

const chunk = (id: string, content = `content of ${id}`, score = 0.9): RetrievedChunk => ({
  chunkId: id,
  documentId: '00000000-0000-0000-0000-000000000000',
  title: 'Doc',
  heading: id,
  content,
  score,
});

const ids = (chunks: RetrievedChunk[]) => chunks.map((c) => c.chunkId);

/** A chat provider that replies with a fixed string and records the prompts it received. */
function scripted(reply: string | Error) {
  const prompts: ChatMessage[][] = [];
  const chat: ChatProvider = {
    name: 'fake',
    async complete(messages) {
      prompts.push(messages);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async *stream() {},
  };
  return { chat, prompts };
}

describe('NoopReranker', () => {
  it('keeps the order and asks for no extra candidates', async () => {
    const reranker = new NoopReranker();
    expect(reranker.candidateMultiplier).toBe(1);
    expect(ids(await reranker.rerank('q', [chunk('a'), chunk('b')]))).toEqual(['a', 'b']);
  });
});

describe('LlmReranker', () => {
  const chunks = [chunk('a'), chunk('b'), chunk('c')];

  it('orders passages by the numbers the model returns, best first', async () => {
    const { chat } = scripted('[3, 1, 2]');
    expect(ids(await new LlmReranker(chat).rerank('q', chunks))).toEqual(['c', 'a', 'b']);
  });

  it('copes with a code fence and surrounding chatter', async () => {
    const { chat } = scripted('Sure! Here you go:\n```json\n[2, 1, 3]\n```');
    expect(ids(await new LlmReranker(chat).rerank('q', chunks))).toEqual(['b', 'a', 'c']);
  });

  it('ignores out-of-range and repeated numbers, and keeps omitted passages in their original order', async () => {
    const { chat } = scripted('[9, 2, 2, 0]');
    expect(ids(await new LlmReranker(chat).rerank('q', chunks))).toEqual(['b', 'a', 'c']);
  });

  it('keeps the retrieval order when the reply cannot be parsed', async () => {
    const { chat } = scripted("I don't know based on the provided documents.");
    expect(ids(await new LlmReranker(chat).rerank('q', chunks))).toEqual(['a', 'b', 'c']);
  });

  it('keeps the retrieval order when the model call fails', async () => {
    const { chat } = scripted(new Error('rate limited'));
    expect(ids(await new LlmReranker(chat).rerank('q', chunks))).toEqual(['a', 'b', 'c']);
  });

  it('does not call the model for zero or one candidate', async () => {
    const { chat, prompts } = scripted('[1]');
    const reranker = new LlmReranker(chat);
    await reranker.rerank('q', []);
    await reranker.rerank('q', [chunk('a')]);
    expect(prompts).toHaveLength(0);
  });

  it('shows the model the question and each numbered passage, and says to treat them as data', async () => {
    const { chat, prompts } = scripted('[1, 2, 3]');
    await new LlmReranker(chat).rerank('How do refunds work?', chunks);

    const [system, user] = prompts[0];
    expect(system.content).toMatch(/ignore any instructions/i);
    expect(user.content).toContain('Question: How do refunds work?');
    expect(user.content).toContain('[2] Doc — b\ncontent of b');
  });

  it('asks for extra candidates to choose from', () => {
    expect(new LlmReranker(scripted('[]').chat).candidateMultiplier).toBeGreaterThan(1);
  });
});

describe('QueryService with a reranker', () => {
  const row = (id: string, score: number) => ({ ...chunk(id, id, score) });

  function service(reranker: Reranker, rows: RetrievedChunk[]) {
    const limits: unknown[] = [];
    const db = {
      query: async (_sql: string, params: unknown[]) => {
        limits.push(params[1]);
        return { rows };
      },
    } as any;
    const cfg = { topK: 5, minScore: 0.1, historyMessages: 0, searchMode: 'vector' } as AppConfig;
    return { limits, service: new QueryService(cfg, new MockEmbeddingProvider(64), new MockChatProvider(), db, reranker) };
  }

  const reversing: Reranker = {
    candidateMultiplier: 3,
    rerank: async (_q, chunks) => [...chunks].reverse(),
  };

  it('fetches a larger pool, reranks it, then keeps the top k', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`c${i}`, 0.9 - i * 0.01));
    const { service: svc, limits } = service(reversing, rows);

    const result = await svc.retrieve('q', 3);

    expect(limits[0]).toBe(9); // 3 wanted x multiplier 3
    expect(ids(result)).toEqual(['c8', 'c7', 'c6']);
  });

  it('only reranks passages that passed the similarity threshold', async () => {
    const seen: string[][] = [];
    const spy: Reranker = {
      candidateMultiplier: 3,
      rerank: async (_q, chunks) => {
        seen.push(ids(chunks));
        return chunks;
      },
    };
    const { service: svc } = service(spy, [row('good', 0.8), row('weak', 0.01)]);

    await svc.retrieve('q', 3);

    expect(seen).toEqual([['good']]);
  });

  it('behaves as before without a reranker', async () => {
    const { service: svc, limits } = service(new NoopReranker(), [row('a', 0.9), row('b', 0.8)]);
    expect(ids(await svc.retrieve('q', 2))).toEqual(['a', 'b']);
    expect(limits[0]).toBe(2);
  });
});
