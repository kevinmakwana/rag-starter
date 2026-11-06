import Anthropic from '@anthropic-ai/sdk';
import { recordModelCall } from '../observability/request-context';
import { ChatMessage, ChatProvider } from './types';

export class AnthropicChatProvider implements ChatProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly maxTokens = 1024,
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
    return { model: this.model, max_tokens: this.maxTokens, temperature: 0.1, system, messages: turns };
  }

  async *stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const started = Date.now();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    const stream = this.client.messages.stream(this.toRequest(messages), { signal });
    try {
      for await (const event of stream) {
        if (event.type === 'message_start') inputTokens = event.message.usage.input_tokens;
        // Cumulative: each message_delta carries the total output tokens so far.
        else if (event.type === 'message_delta') outputTokens = event.usage.output_tokens;
        else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
      }
    } finally {
      // An abandoned stream never reaches its final message_delta, so outputTokens stays unknown.
      recordModelCall({
        kind: 'chat',
        provider: this.name,
        model: this.model,
        inputTokens,
        outputTokens,
        ms: Date.now() - started,
      });
    }
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    const started = Date.now();
    const res = await this.client.messages.create(this.toRequest(messages));
    recordModelCall({
      kind: 'chat',
      provider: this.name,
      model: this.model,
      inputTokens: res.usage?.input_tokens,
      outputTokens: res.usage?.output_tokens,
      ms: Date.now() - started,
    });
    return res.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }
}
