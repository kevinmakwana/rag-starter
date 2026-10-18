import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { MockChatProvider, MockEmbeddingProvider } from '../src/providers/mock.provider';
import { ChatMessage, ChatProvider } from '../src/providers/types';
import { formatSseEvent } from '../src/query/sse';
import { QueryService, QueryStreamEvent } from '../src/query/query.service';

const cfg = { topK: 5, minScore: 0 } as AppConfig;

const row = (content: string, score: number) => ({
  chunkId: '1',
  documentId: '00000000-0000-0000-0000-000000000000',
  title: 'Doc',
  heading: 'Parking',
  content,
  score,
});

/** A database stub that returns canned retrieval rows. */
const fakeDb = (rows: ReturnType<typeof row>[]) => ({ query: async () => ({ rows }) }) as any;

async function collect(events: AsyncIterable<QueryStreamEvent>): Promise<QueryStreamEvent[]> {
  const out: QueryStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('formatSseEvent', () => {
  it('frames a named event with JSON data and a blank-line terminator', () => {
    expect(formatSseEvent('token', { text: 'hi' })).toBe('event: token\ndata: {"text":"hi"}\n\n');
  });

  it('keeps newlines inside the JSON payload on a single data line', () => {
    expect(formatSseEvent('token', { text: 'a\nb' })).toBe('event: token\ndata: {"text":"a\\nb"}\n\n');
  });
});

describe('MockChatProvider.stream', () => {
  it('yields several chunks that join to the full completion', async () => {
    const mock = new MockChatProvider();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'Context:\n\n[1] Doc\nVisitors park in bay C.\n\nQuestion: where?' },
    ];
    const chunks: string[] = [];
    for await (const piece of mock.stream(messages)) chunks.push(piece);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(await mock.complete(messages));
  });
});

describe('QueryService.askStream', () => {
  const embeddings = new MockEmbeddingProvider(64);

  it('emits sources first, then tokens, then a done event with cited sources', async () => {
    const chat: ChatProvider = {
      name: 'fake',
      complete: async () => '',
      async *stream() {
        yield 'Visitors park ';
        yield 'in bay C ';
        yield '[1].';
      },
    };
    const service = new QueryService(cfg, embeddings, chat, fakeDb([row('Visitors park in bay C.', 0.8)]));

    const events = await collect(service.askStream('Where do visitors park?'));

    expect(events.map((e) => e.type)).toEqual(['sources', 'token', 'token', 'token', 'done']);
    const sources = events[0] as Extract<QueryStreamEvent, { type: 'sources' }>;
    expect(sources.sources).toHaveLength(1);
    expect(sources.sources[0].cited).toBe(false); // unknown until the answer is complete

    const done = events[4] as Extract<QueryStreamEvent, { type: 'done' }>;
    expect(done.result.answer).toBe('Visitors park in bay C [1].');
    expect(done.result.sources[0].cited).toBe(true);
    expect(done.result.meta.chatProvider).toBe('fake');
  });

  it('answers "I don\'t know" without calling the model when nothing is retrieved', async () => {
    let called = false;
    const chat: ChatProvider = {
      name: 'fake',
      complete: async () => '',
      async *stream() {
        called = true;
        yield 'should not happen';
      },
    };
    const service = new QueryService(cfg, embeddings, chat, fakeDb([]));

    const events = await collect(service.askStream('Anything?'));

    expect(called).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['sources', 'token', 'done']);
    const done = events[2] as Extract<QueryStreamEvent, { type: 'done' }>;
    expect(done.result.answer).toMatch(/don't know/);
    expect(done.result.sources).toHaveLength(0);
  });
});
