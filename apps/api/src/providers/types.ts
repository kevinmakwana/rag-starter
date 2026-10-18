export interface EmbeddingProvider {
  readonly name: string;
  /** Model identifier, recorded with each document so mixed-model indexes can be detected. */
  readonly model: string;
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
  /** Yield the answer as text deltas. Aborting `signal` cancels the upstream request. */
  stream(messages: ChatMessage[], signal?: AbortSignal): AsyncIterable<string>;
}

export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
export const CHAT_PROVIDER = Symbol('CHAT_PROVIDER');
