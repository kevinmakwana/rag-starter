import OpenAI from 'openai';
import { recordModelCall } from '../observability/request-context';
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
      const started = Date.now();
      const res = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        // Only text-embedding-3 models accept `dimensions`; other servers reject the request outright.
        ...(/^text-embedding-3/.test(this.model) ? { dimensions: this.dimensions } : {}),
      });
      recordModelCall({
        kind: 'embedding',
        provider: this.name,
        model: this.model,
        inputTokens: res.usage?.prompt_tokens,
        outputTokens: 0,
        ms: Date.now() - started,
      });
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
    const started = Date.now();
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0.1,
    });
    recordModelCall({
      kind: 'chat',
      provider: this.name,
      model: this.model,
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
      ms: Date.now() - started,
    });
    return res.choices[0]?.message?.content?.trim() ?? '';
  }

  async *stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const started = Date.now();
    let usage: { prompt_tokens: number; completion_tokens: number } | undefined;
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
    try {
      for await (const chunk of res) {
        if (chunk.usage) usage = chunk.usage;
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    } finally {
      // Runs when the caller stops reading too: the usage chunk comes last, so an abandoned stream has none.
      recordModelCall({
        kind: 'chat',
        provider: this.name,
        model: this.model,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        ms: Date.now() - started,
      });
    }
  }
}
