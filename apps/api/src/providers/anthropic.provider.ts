import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, ChatProvider } from './types';

export class AnthropicChatProvider implements ChatProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  /** Anthropic takes the system prompt as a separate field. */
  private toRequest(messages: ChatMessage[]) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    return { model: this.model, max_tokens: 1024, temperature: 0.1, system, messages: turns };
  }

  async *stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const stream = this.client.messages.stream(this.toRequest(messages), { signal });
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const res = await this.client.messages.create(this.toRequest(messages));
    return res.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }
}
