import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { RequestContext, runInRequestContext } from '../src/observability/request-context';
import { MockEmbeddingProvider } from '../src/providers/mock.provider';
import { ChatProvider } from '../src/providers/types';
import { QueryService } from '../src/query/query.service';

const cfg = { topK: 5, minScore: 0, historyMessages: 4 } as AppConfig;
const row = {
  chunkId: '1',
  documentId: '00000000-0000-0000-0000-000000000000',
  title: 'Pricing',
  heading: 'Billing',
  content: 'Annual plans are billed once a year.',
  score: 0.8,
};
const chat = (answer: string): ChatProvider => ({
  name: 'fake',
  async complete() {
    return answer;
  },
  async *stream() {
    yield answer;
  },
});
const serviceWith = (rows: unknown[], answer = 'Billed yearly [1].') =>
  new QueryService(cfg, new MockEmbeddingProvider(64), chat(answer), { query: async () => ({ rows }) } as any);

const inRequest = async (fn: () => Promise<unknown>) => {
  const ctx: RequestContext = { requestId: 'test-request', calls: [] };
  await runInRequestContext(ctx, fn);
  return ctx;
};

describe('query telemetry', () => {
  it('records retrieval and answer time and how many passages were found', async () => {
    const ctx = await inRequest(() => serviceWith([row]).ask('How are annual plans billed?'));
    expect(ctx.query).toMatchObject({ retrieved: 1 });
    expect(typeof ctx.query?.retrieveMs).toBe('number');
    expect(typeof ctx.query?.answerMs).toBe('number');
    expect(ctx.query).not.toHaveProperty('rewriteMs'); // no history, so no rewrite call
    expect(ctx.query).not.toHaveProperty('citationsMissing');
  });

  it('records the rewrite time only when a follow-up was actually rewritten', async () => {
    const history = [
      { role: 'user' as const, content: 'What plans exist?' },
      { role: 'assistant' as const, content: 'Free and Team.' },
    ];
    const ctx = await inRequest(() => serviceWith([row]).ask('and annual?', 5, undefined, history));
    expect(typeof ctx.query?.rewriteMs).toBe('number');
  });

  it('flags an answer that cites none of the passages', async () => {
    const ctx = await inRequest(() => serviceWith([row], 'It depends.').ask('How are annual plans billed?'));
    expect(ctx.query?.citationsMissing).toBe(true);
  });

  it('records a zero count and the retrieval time when nothing was found, without an answer time', async () => {
    const ctx = await inRequest(() => serviceWith([]).ask('Unrelated question?'));
    expect(ctx.query).toMatchObject({ retrieved: 0 });
    expect(typeof ctx.query?.retrieveMs).toBe('number');
    expect(ctx.query).not.toHaveProperty('answerMs');
  });

  it('records the same for a streamed answer', async () => {
    const ctx = await inRequest(async () => {
      for await (const _ of serviceWith([row]).askStream('How are annual plans billed?')) void _;
    });
    expect(ctx.query).toMatchObject({ retrieved: 1 });
    expect(typeof ctx.query?.retrieveMs).toBe('number');
    expect(typeof ctx.query?.answerMs).toBe('number');
  });

  it('records the retrieval time even when the visitor abandons the stream before the answer', async () => {
    const ctx = await inRequest(async () => {
      for await (const event of serviceWith([row]).askStream('How are annual plans billed?')) {
        if (event.type === 'sources') break;
      }
    });
    expect(typeof ctx.query?.retrieveMs).toBe('number');
  });

  it('works unchanged outside a request', async () => {
    await expect(serviceWith([row]).ask('How are annual plans billed?')).resolves.toBeDefined();
  });
});
