export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  /** Embed many texts; implementations batch internally. Order is preserved. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatProvider {
  readonly name: string;
  complete(messages: ChatMessage[]): Promise<string>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
export const CHAT_PROVIDER = Symbol('CHAT_PROVIDER');
