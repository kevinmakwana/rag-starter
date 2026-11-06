import 'reflect-metadata';
import { loadConfig } from '../src/config';
import { ModelCall, RequestContext, runInRequestContext } from '../src/observability/request-context';
import { AnthropicChatProvider } from '../src/providers/anthropic.provider';
import { OpenAIChatProvider, OpenAIEmbeddingProvider } from '../src/providers/openai.provider';

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

/** Run `fn` inside a request context and return the model calls it recorded. */
async function metered(fn: () => Promise<unknown>): Promise<ModelCall[]> {
  const ctx: RequestContext = { requestId: 'test-request', calls: [] };
  await runInRequestContext(ctx, fn);
  return ctx.calls;
}

describe('OpenAI usage metering', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  const chatClient = (reply: (req: any) => any) => {
    const requests: any[] = [];
    const client = { chat: { completions: { create: async (req: any) => (requests.push(req), reply(req)) } } } as any;
    return { client, requests };
  };

  it('records the tokens of a completed answer', async () => {
    const { client } = chatClient(() => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 },
    }));
    const calls = await metered(() => new OpenAIChatProvider(client, 'gpt-x').complete(messages));
    expect(calls).toEqual([
      expect.objectContaining({ kind: 'chat', provider: 'openai', model: 'gpt-x', inputTokens: 120, outputTokens: 30 }),
    ]);
  });

  it('records the call without tokens when the server reports no usage (instead of inventing zeros)', async () => {
    const { client } = chatClient(() => ({ choices: [{ message: { content: 'ok' } }] }));
    const [call] = await metered(() => new OpenAIChatProvider(client, 'gpt-x').complete(messages));
    expect(call.inputTokens).toBeUndefined();
    expect(call.outputTokens).toBeUndefined();
  });

  it('asks a streamed answer to include usage, and records it from the final chunk', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [], usage: { prompt_tokens: 50, completion_tokens: 2 } },
    ];
    const { client, requests } = chatClient(() =>
      (async function* () {
        yield* chunks;
      })(),
    );
    let text = '';
    const calls = await metered(async () => {
      for await (const t of new OpenAIChatProvider(client, 'gpt-x').stream(messages)) text += t;
    });
    expect(text).toBe('Hello');
    expect(requests[0].stream_options).toEqual({ include_usage: true });
    expect(calls[0]).toMatchObject({ inputTokens: 50, outputTokens: 2 });
  });

  it('does not send stream_options to a custom base URL, and reports that answer\u2019s tokens as unknown', async () => {
    const { client, requests } = chatClient(() =>
      (async function* () {
        yield { choices: [{ delta: { content: 'x' } }] };
      })(),
    );
    const calls = await metered(async () => {
      for await (const _ of new OpenAIChatProvider(client, 'llama', false).stream(messages)) void _;
    });
    expect(requests[0]).not.toHaveProperty('stream_options');
    expect(calls[0].inputTokens).toBeUndefined();
  });

  it('still records a streamed answer the caller stopped reading, with tokens unknown', async () => {
    const { client } = chatClient(() =>
      (async function* () {
        yield { choices: [{ delta: { content: 'a' } }] };
        yield { choices: [{ delta: { content: 'b' } }] };
        yield { choices: [], usage: { prompt_tokens: 9, completion_tokens: 9 } };
      })(),
    );
    const calls = await metered(async () => {
      for await (const _ of new OpenAIChatProvider(client, 'gpt-x').stream(messages)) {
        void _;
        break; // the visitor closed the page
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].inputTokens).toBeUndefined();
  });

  it('records embedding tokens per batch, with no output tokens', async () => {
    const client = {
      embeddings: {
        create: async (req: any) => ({
          data: req.input.map((_: string, index: number) => ({ index, embedding: [0.1, 0.2] })),
          usage: { prompt_tokens: 7, total_tokens: 7 },
        }),
      },
    } as any;
    const calls = await metered(() =>
      new OpenAIEmbeddingProvider(client, 'text-embedding-3-small', 2).embed(['a', 'b']),
    );
    expect(calls).toEqual([
      expect.objectContaining({
        kind: 'embedding',
        provider: 'openai',
        model: 'text-embedding-3-small',
        inputTokens: 7,
        outputTokens: 0,
      }),
    ]);
  });

  it('counts a call that failed, with its tokens unknown, and still throws the original error', async () => {
    const boom = new Error('429 rate limited');
    const { client } = chatClient(() => {
      throw boom;
    });
    let thrown: unknown;
    const calls = await metered(async () => {
      thrown = await new OpenAIChatProvider(client, 'gpt-x').complete(messages).catch((e) => e);
    });
    expect(thrown).toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0].inputTokens).toBeUndefined();
  });

  it('counts a stream that the SDK breaks halfway, and keeps the original error', async () => {
    const boom = new Error('connection reset');
    const { client } = chatClient(() =>
      (async function* () {
        yield { choices: [{ delta: { content: 'a' } }] };
        throw boom;
      })(),
    );
    let thrown: unknown;
    const calls = await metered(async () => {
      try {
        for await (const _ of new OpenAIChatProvider(client, 'gpt-x').stream(messages)) void _;
      } catch (e) {
        thrown = e;
      }
    });
    expect(thrown).toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0].outputTokens).toBeUndefined();
  });

  it('counts a failed embedding batch too', async () => {
    const client = { embeddings: { create: async () => { throw new Error('boom'); } } } as any;
    const calls = await metered(() => new OpenAIEmbeddingProvider(client, 'text-embedding-3-small', 2).embed(['a']).catch(() => undefined));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'embedding' });
    expect(calls[0].inputTokens).toBeUndefined();
  });

  it('works unchanged outside a request (no context to record into)', async () => {
    const { client } = chatClient(() => ({ choices: [{ message: { content: ' ok ' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    await expect(new OpenAIChatProvider(client, 'gpt-x').complete(messages)).resolves.toBe('ok');
  });
});

describe('Anthropic usage metering', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  it('counts a call that failed, with its tokens unknown, and still throws the original error', async () => {
    const boom = new Error('overloaded');
    const client = { messages: { create: async () => { throw boom; } } } as any;
    let thrown: unknown;
    const calls = await metered(async () => {
      thrown = await new AnthropicChatProvider(client, 'claude-x').complete(messages).catch((e) => e);
    });
    expect(thrown).toBe(boom);
    expect(calls).toHaveLength(1);
    expect(calls[0].inputTokens).toBeUndefined();
  });

  it('records the tokens of a completed answer', async () => {
    const client = {
      messages: {
        create: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 80, output_tokens: 12 } }),
      },
    } as any;
    const calls = await metered(() => new AnthropicChatProvider(client, 'claude-x').complete(messages));
    expect(calls).toEqual([
      expect.objectContaining({ kind: 'chat', provider: 'anthropic', model: 'claude-x', inputTokens: 80, outputTokens: 12 }),
    ]);
  });

  it('records a streamed answer\u2019s tokens from message_start (input) and message_delta (output so far)', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 60, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_delta', usage: { output_tokens: 5 } },
      { type: 'message_delta', usage: { output_tokens: 9 } },
    ];
    const client = {
      messages: {
        stream: () =>
          (async function* () {
            yield* events;
          })(),
      },
    } as any;
    let text = '';
    const calls = await metered(async () => {
      for await (const t of new AnthropicChatProvider(client, 'claude-x').stream(messages)) text += t;
    });
    expect(text).toBe('Hi');
    expect(calls[0]).toMatchObject({ inputTokens: 60, outputTokens: 9 });
  });

  it('records an abandoned stream with the tokens it never received left unknown', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 60, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
    ];
    const client = {
      messages: {
        stream: () =>
          (async function* () {
            yield* events;
          })(),
      },
    } as any;
    const calls = await metered(async () => {
      for await (const _ of new AnthropicChatProvider(client, 'claude-x').stream(messages)) {
        void _;
        break;
      }
    });
    expect(calls[0].inputTokens).toBe(60);
    expect(calls[0].outputTokens).toBeUndefined();
  });
});
