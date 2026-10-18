import 'reflect-metadata';
import { loadConfig } from '../src/config';
import { AnthropicChatProvider } from '../src/providers/anthropic.provider';
import { OpenAIEmbeddingProvider } from '../src/providers/openai.provider';

/** An OpenAI client stub that records embedding requests and answers with vectors of `size`. */
function fakeOpenAI(size: number) {
  const requests: any[] = [];
  const client = {
    embeddings: {
      create: async (req: any) => {
        requests.push(req);
        return { data: req.input.map((_: string, index: number) => ({ index, embedding: new Array(size).fill(0.1) })) };
      },
    },
  } as any;
  return { client, requests };
}

describe('OpenAIEmbeddingProvider', () => {
  it('asks text-embedding-3 models for the configured number of dimensions', async () => {
    const { client, requests } = fakeOpenAI(8);
    await new OpenAIEmbeddingProvider(client, 'text-embedding-3-small', 8).embed(['a']);
    expect(requests[0].dimensions).toBe(8);
  });

  it('omits `dimensions` for other models, which reject the parameter (Ollama, ada-002, ...)', async () => {
    const { client, requests } = fakeOpenAI(8);
    await new OpenAIEmbeddingProvider(client, 'nomic-embed-text', 8).embed(['a']);
    expect(requests[0]).not.toHaveProperty('dimensions');
  });

  it('fails clearly when a model returns vectors of a different size than EMBEDDING_DIM', async () => {
    const { client } = fakeOpenAI(768);
    const provider = new OpenAIEmbeddingProvider(client, 'nomic-embed-text', 1536);
    await expect(provider.embed(['a'])).rejects.toThrow(/768.*EMBEDDING_DIM=1536|EMBEDDING_DIM=1536.*768/s);
  });
});

describe('AnthropicChatProvider', () => {
  const messages = [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' },
  ];

  it('uses the configured max_tokens for answers', async () => {
    const requests: any[] = [];
    const client = {
      messages: { create: async (req: any) => (requests.push(req), { content: [{ type: 'text', text: 'ok' }] }) },
    } as any;

    await new AnthropicChatProvider(client, 'm', 4096).complete(messages);

    expect(requests[0].max_tokens).toBe(4096);
  });

  it('uses it for streamed answers too', async () => {
    const requests: any[] = [];
    const client = { messages: { stream: (req: any) => (requests.push(req), (async function* () {})()) } } as any;

    for await (const _ of new AnthropicChatProvider(client, 'm', 4096).stream(messages));

    expect(requests[0].max_tokens).toBe(4096);
  });
});

describe('loadConfig for providers', () => {
  const KEYS = ['EMBEDDING_PROVIDER', 'CHAT_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MAX_TOKENS'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    KEYS.forEach((k) => {
      saved[k] = process.env[k];
      delete process.env[k];
    });
  });
  afterEach(() => {
    KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  });

  it('still requires an API key for OpenAI itself', () => {
    process.env.EMBEDDING_PROVIDER = 'openai';
    expect(() => loadConfig()).toThrow(/OPENAI_API_KEY/);
  });

  it('does not require one when pointed at an OpenAI-compatible server', () => {
    Object.assign(process.env, { EMBEDDING_PROVIDER: 'openai', CHAT_PROVIDER: 'openai', OPENAI_BASE_URL: 'http://localhost:11434/v1' });
    const cfg = loadConfig();
    expect(cfg.openai.baseUrl).toBe('http://localhost:11434/v1');
    expect(cfg.openai.apiKey).toBeUndefined();
  });

  it('reads ANTHROPIC_MAX_TOKENS, defaulting to 1024', () => {
    expect(loadConfig().anthropic.maxTokens).toBe(1024);
    process.env.ANTHROPIC_MAX_TOKENS = '4096';
    expect(loadConfig().anthropic.maxTokens).toBe(4096);
  });

  it.each(['0', '-5', '1.5'])('rejects ANTHROPIC_MAX_TOKENS=%s', (value) => {
    process.env.ANTHROPIC_MAX_TOKENS = value;
    expect(() => loadConfig()).toThrow(/ANTHROPIC_MAX_TOKENS/);
  });
});
