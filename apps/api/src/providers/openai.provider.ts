import OpenAI from 'openai';
import { ChatMessage, ChatProvider, EmbeddingProvider } from './types';

const EMBED_BATCH = 96;

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    readonly dimensions: number,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      const res = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dimensions,
      });
      // The API returns items with an index; sort defensively to keep order.
      res.data.sort((a, b) => a.index - b.index).forEach((d) => out.push(d.embedding));
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
}
