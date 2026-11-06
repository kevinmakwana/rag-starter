import OpenAI from 'openai';
import { startModelCall } from '../observability/request-context';
import { ChatMessage, ChatProvider, EmbeddingProvider } from './types';

const EMBED_BATCH = 96;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    readonly dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const call = startModelCall({ kind: 'embedding', provider: this.name, model: this.model });
      let res: Awaited<ReturnType<typeof this.client.embeddings.create>> | undefined;
      try {
        res = await this.client.embeddings.create({
          model: this.model,
          input: batch,
          // Only text-embedding-3 models accept `dimensions`; other servers reject the request outright.
          ...(/^text-embedding-3/.test(this.model) ? { dimensions: this.dimensions } : {}),
        });
      } finally {
        call.finish({ inputTokens: res?.usage?.prompt_tokens, outputTokens: 0 });
      }
      // The API returns items with an index; sort defensively to keep order.
      for (const { embedding } of res.data.sort((a, b) => a.index - b.index)) {
        if (embedding.length !== this.dimensions) {
          throw new Error(
            `Embedding model "${this.model}" returned ${embedding.length}-dimensional vectors but ` +
              `EMBEDDING_DIM=${this.dimensions}. Set EMBEDDING_DIM to ${embedding.length} (and re-create the ` +
              'chunks table) or choose a model that matches.',
          );
        }
        out.push(embedding);
      }
    }
    return out;
  }
}

export class OpenAIChatProvider implements ChatProvider {
  readonly name = 'openai';

  /**
   * `reportStreamUsage` asks a streamed answer to end with a usage chunk. Servers other than OpenAI's own
   * (Ollama, vLLM, ...) may reject the option, so the caller turns it off for a custom base URL and the
   * tokens of streamed answers are then unknown.
   */
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly reportStreamUsage = true,
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const call = startModelCall({ kind: 'chat', provider: this.name, model: this.model });
    let usage: { inputTokens?: number; outputTokens?: number } = {};
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages,
        temperature: 0.1,
      });
      usage = { inputTokens: res.usage?.prompt_tokens, outputTokens: res.usage?.completion_tokens };
      return res.choices[0]?.message?.content?.trim() ?? '';
    } finally {
      call.finish(usage);
    }
  }

  async *stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const call = startModelCall({ kind: 'chat', provider: this.name, model: this.model });
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
    try {
      const res = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          temperature: 0.1,
          stream: true,
          ...(this.reportStreamUsage ? { stream_options: { include_usage: true } } : {}),
        },
        { signal },
      );
      for await (const chunk of res) {
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    } finally {
      // Runs when the caller stops reading or the SDK throws too: the usage chunk comes last, so an
      // abandoned or broken stream has none and its tokens stay unknown.
      call.finish({ inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens });
    }
  }
}
