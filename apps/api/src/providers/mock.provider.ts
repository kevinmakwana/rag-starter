import { createHash } from 'crypto';
import { REWRITE_SYSTEM_PROMPT } from '../query/prompt';
import { ChatMessage, ChatProvider, EmbeddingProvider } from './types';

const STOPWORDS = new Set(
  (
    'a an and are as at be by can do does for from has have how i in is it its of on or ' +
    'that the this to was what when where which who why will with you your'
  ).split(' '),
);

/** Crude suffix stripping so "deploys", "deployment" and "deploy" share a feature. */
export function stem(token: string): string {
  for (const suffix of ['ments', 'ment', 'ing', 'ies', 'ed', 'es', 's']) {
    if (token.length - suffix.length >= 4 && token.endsWith(suffix)) {
      return suffix === 'ies' ? `${token.slice(0, -3)}y` : token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Offline embeddings via feature hashing (a hashed, lightly stemmed bag of words).
 * Deterministic and free, so the whole app runs and is testable without an API key.
 * Retrieval is keyword-level, not semantic: swap to a real provider for production.
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';
  readonly model = 'hashed-bow';

  constructor(readonly dimensions: number) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const feature of tokenize(text)) {
      const digest = createHash('md5').update(feature).digest();
      const index = digest.readUInt32BE(0) % this.dimensions;
      const sign = digest[4] & 1 ? 1 : -1;
      vec[index] += sign;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    // pgvector cannot compute cosine distance for a zero vector; nudge it.
    if (norm === 0) {
      vec[0] = 1;
      return vec;
    }
    return vec.map((v) => v / norm);
  }
}

/** Echoes the retrieved context so the UI flow can be tried without an LLM. */
export class MockChatProvider implements ChatProvider {
  readonly name = 'mock';

  async complete(messages: ChatMessage[]): Promise<string> {
    if (messages[0]?.content === REWRITE_SYSTEM_PROMPT) return this.rewrite(messages);
    const user = messages.filter((m) => m.role === 'user').pop()?.content ?? '';
    const firstSource = user.match(/\[1\][^\n]*\n([\s\S]*?)(?:\n\[2\]|\n\nQuestion:)/);
    if (!firstSource) {
      return "I don't know based on the provided documents.";
    }
    const excerpt = firstSource[1].trim().replace(/\s+/g, ' ').slice(0, 400);
    return (
      `(Mock mode: no LLM is configured, so this is the top retrieved passage.)\n\n` +
      `${excerpt}${excerpt.length >= 400 ? '…' : ''} [1]`
    );
  }

  /**
   * Offline stand-in for question rewriting: prepend the previous user question to the follow-up.
   * Crude (it does it even for self-contained questions) but enough for keyword retrieval.
   */
  private rewrite(messages: ChatMessage[]): string {
    const prompt = messages[1]?.content ?? '';
    const followUp = prompt.match(/Follow-up question: (.*)\n\nStandalone question:/s)?.[1] ?? '';
    const previous = [...prompt.matchAll(/^User: (.*)$/gm)].pop()?.[1] ?? '';
    return `${previous} ${followUp}`.trim();
  }

  /** Word-by-word, with a small delay so the streaming UI is visible offline. */
  async *stream(messages: ChatMessage[], signal?: AbortSignal): AsyncGenerator<string> {
    const answer = await this.complete(messages);
    // Split after whitespace so the pieces always join back to the original text.
    for (const piece of answer.split(/(?<=\s)(?=\S)/)) {
      if (signal?.aborted) return;
      yield piece;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}
