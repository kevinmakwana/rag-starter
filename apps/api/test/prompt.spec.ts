import { MockChatProvider, MockEmbeddingProvider } from '../src/providers/mock.provider';
import { buildMessages, citedIndexes, RetrievedChunk } from '../src/query/prompt';

const chunk = (title: string, heading: string | null, content: string): RetrievedChunk => ({
  chunkId: '1',
  documentId: '00000000-0000-0000-0000-000000000000',
  title,
  heading,
  content,
  score: 0.9,
});

describe('buildMessages', () => {
  it('numbers passages and labels them with title and heading', () => {
    const [system, user] = buildMessages('How do I deploy?', [
      chunk('Handbook', 'Deploys', 'Merge to main.'),
      chunk('FAQ', null, 'Ask in #help.'),
    ]);
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/only the numbered context/);
    expect(user.content).toContain('[1] Handbook — Deploys\nMerge to main.');
    expect(user.content).toContain('[2] FAQ\nAsk in #help.');
    expect(user.content.endsWith('Question: How do I deploy?')).toBe(true);
  });
});

describe('citedIndexes', () => {
  it('returns unique, in-range citations in order of first use', () => {
    expect(citedIndexes('Yes [2]. Also [1][2] and [9].', 3)).toEqual([2, 1]);
  });
});

describe('mock providers', () => {
  it('produces normalized, deterministic embeddings that rank keyword matches first', async () => {
    const provider = new MockEmbeddingProvider(256);
    const [q, hit, miss] = await provider.embed([
      'refund policy',
      'Our refund policy allows returns within 30 days.',
      'The office is closed on public holidays.',
    ]);
    const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
    expect(Math.hypot(...q)).toBeCloseTo(1, 5);
    expect(dot(q, hit)).toBeGreaterThan(dot(q, miss));
    expect(await provider.embed(['refund policy'])).toEqual([q]);
  });

  it('mock chat answers from the first passage with a citation', async () => {
    const messages = buildMessages('q', [chunk('Doc', null, 'The answer is 42.'), chunk('Doc', null, 'Other.')]);
    const answer = await new MockChatProvider().complete(messages);
    expect(answer).toContain('The answer is 42.');
    expect(answer).toContain('[1]');
  });
});
