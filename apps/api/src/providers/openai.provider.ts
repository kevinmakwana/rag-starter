import OpenAI from 'openai';
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
      const res = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        // Only text-embedding-3 models accept `dimensions`; other servers reject the request outright.
        ...(/^text-embedding-3/.test(this.model) ? { dimensions: this.dimensions } : {}),
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

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0.1,
    });
    return res.choices[0]?.message?.content?.trim() ?? '';
  }

  async *stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const res = await this.client.chat.completions.create(
      { model: this.model, messages, temperature: 0.1, stream: true },
      { signal },
    );
    for await (const chunk of res) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}
