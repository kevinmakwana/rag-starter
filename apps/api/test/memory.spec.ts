import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { MockChatProvider, MockEmbeddingProvider } from '../src/providers/mock.provider';
import { ChatMessage, ChatProvider } from '../src/providers/types';
import { buildRewriteMessages, HistoryMessage, REWRITE_SYSTEM_PROMPT, trimHistory } from '../src/query/prompt';
import { QueryService } from '../src/query/query.service';

const cfg = { topK: 5, minScore: 0, historyMessages: 4 } as AppConfig;

const history: HistoryMessage[] = [
  { role: 'user', content: 'What does the Team plan cost?' },
  { role: 'assistant', content: 'The Team plan is $12 per seat per month [1].' },
];

describe('trimHistory', () => {
  it('keeps only the most recent messages', () => {
    const many: HistoryMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));
    expect(trimHistory(many, { maxMessages: 4, maxChars: 100 }).map((m) => m.content)).toEqual(['m6', 'm7', 'm8', 'm9']);
  });

  it('truncates long messages and drops empty ones', () => {
    const out = trimHistory(
      [
        { role: 'user', content: 'x'.repeat(50) },
        { role: 'assistant', content: '   ' },
      ],
      { maxMessages: 10, maxChars: 10 },
    );
    expect(out).toEqual([{ role: 'user', content: 'xxxxxxxxxx' }]);
  });

  it('treats a missing history as empty', () => {
    expect(trimHistory(undefined, { maxMessages: 4, maxChars: 100 })).toEqual([]);
  });
});

describe('buildRewriteMessages', () => {
  it('puts the conversation, in order, before the follow-up question', () => {
    const [system, user] = buildRewriteMessages('and for annual plans?', history);
    expect(system).toEqual({ role: 'system', content: REWRITE_SYSTEM_PROMPT });
    const text = user.content;
    expect(text.indexOf('User: What does the Team plan cost?')).toBeLessThan(text.indexOf('Assistant: The Team plan'));
    expect(text).toContain('Follow-up question: and for annual plans?');
  });
});

describe('MockChatProvider rewrite', () => {
  it('folds the previous user question into the follow-up so keyword retrieval still works offline', async () => {
    const rewritten = await new MockChatProvider().complete(buildRewriteMessages('and for annual plans?', history));
    expect(rewritten).toContain('Team plan');
    expect(rewritten).toContain('annual plans');
  });
});

describe('QueryService conversation memory', () => {
  const row = {
    chunkId: '1',
    documentId: '00000000-0000-0000-0000-000000000000',
    title: 'Pricing',
    heading: null,
    content: 'Annual plans are billed once a year.',
    score: 0.8,
  };
  const db = { query: async () => ({ rows: [row] }) } as any;

  /** Records every text that gets embedded, i.e. the query retrieval actually used. */
  class SpyEmbeddings extends MockEmbeddingProvider {
    embedded: string[] = [];
    override async embed(texts: string[]) {
      this.embedded.push(...texts);
      return super.embed(texts);
    }
  }

  function setup(rewrite: (messages: ChatMessage[]) => Promise<string> | string) {
    const embeddings = new SpyEmbeddings(64);
    const calls: { kind: 'complete' | 'stream'; messages: ChatMessage[] }[] = [];
    const chat: ChatProvider = {
      name: 'fake',
      async complete(messages) {
        calls.push({ kind: 'complete', messages });
        return messages[0].content === REWRITE_SYSTEM_PROMPT ? rewrite(messages) : 'Billed yearly [1].';
      },
      async *stream(messages) {
        calls.push({ kind: 'stream', messages });
        yield 'Billed yearly [1].';
      },
    };
    return { embeddings, calls, service: new QueryService(cfg, embeddings, chat, db) };
  }

  it('makes no extra model call when there is no history', async () => {
    const { service, embeddings, calls } = setup(() => 'unused');

    const result = await service.ask('How are annual plans billed?');

    expect(calls.filter((c) => c.messages[0].content === REWRITE_SYSTEM_PROMPT)).toHaveLength(0);
    expect(embeddings.embedded).toEqual(['How are annual plans billed?']);
    expect(result.meta.rewrittenQuestion).toBeUndefined();
  });

  it('rewrites a follow-up into a standalone question and retrieves with that', async () => {
    const { service, embeddings, calls } = setup(() => 'How are annual Team plans billed?');

    const result = await service.ask('and for annual plans?', undefined, undefined, history);

    expect(embeddings.embedded).toEqual(['How are annual Team plans billed?']);
    expect(result.meta.rewrittenQuestion).toBe('How are annual Team plans billed?');
    const answerCall = calls.find((c) => c.messages[0].content !== REWRITE_SYSTEM_PROMPT)!;
    expect(answerCall.messages[1].content).toContain('Question: How are annual Team plans billed?');
  });

  it('falls back to the original question when the rewrite fails', async () => {
    const { service, embeddings } = setup(() => {
      throw new Error('rewrite blew up');
    });

    const result = await service.ask('and for annual plans?', undefined, undefined, history);

    expect(embeddings.embedded).toEqual(['and for annual plans?']);
    expect(result.answer).toContain('Billed yearly');
    expect(result.meta.rewrittenQuestion).toBeUndefined();
  });

  it('caps how much history reaches the rewrite prompt', async () => {
    const { service, calls } = setup(() => 'standalone');
    const long: HistoryMessage[] = Array.from({ length: 10 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn-${i}`,
    }));

    await service.ask('follow up?', undefined, undefined, long);

    const prompt = calls[0].messages[1].content;
    expect(prompt).toContain('turn-9');
    expect(prompt).toContain('turn-6');
    expect(prompt).not.toContain('turn-5');
  });

  it('uses history for streamed answers too', async () => {
    const { service, embeddings } = setup(() => 'How are annual Team plans billed?');

    for await (const _ of service.askStream('and for annual plans?', undefined, undefined, undefined, history));

    expect(embeddings.embedded).toEqual(['How are annual Team plans billed?']);
  });
});
