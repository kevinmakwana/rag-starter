import Anthropic from '@anthropic-ai/sdk';
import { ChatMessage, ChatProvider } from './types';

export class AnthropicChatProvider implements ChatProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    // Anthropic takes the system prompt as a separate field.
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      temperature: 0.1,
      system,
      messages: turns,
    });
    return res.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }
}
