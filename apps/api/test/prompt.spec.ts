import { MockChatProvider, MockEmbeddingProvider } from '../src/providers/mock.provider';
import { buildMessages, citedIndexes, isRefusal, RetrievedChunk } from '../src/query/prompt';

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

  it('accepts several numbers in one bracket', () => {
    expect(citedIndexes('Both apply [1, 3].', 3)).toEqual([1, 3]);
    expect(citedIndexes('Both apply [3,1,2].', 3)).toEqual([3, 1, 2]);
  });

  it('expands ranges, with a hyphen or an en dash', () => {
    expect(citedIndexes('See [1-3].', 5)).toEqual([1, 2, 3]);
    expect(citedIndexes('See [2–4].', 5)).toEqual([2, 3, 4]);
    expect(citedIndexes('See [1-2, 5].', 5)).toEqual([1, 2, 5]);
  });

  it('drops out-of-range numbers inside lists and ranges, and clamps huge ranges', () => {
    expect(citedIndexes('Maybe [1, 9].', 3)).toEqual([1]);
    expect(citedIndexes('Maybe [2-9].', 3)).toEqual([2, 3]);
    expect(citedIndexes('Silly [1-999999999].', 3)).toEqual([1, 2, 3]);
  });

  it('ignores brackets that are not citations', () => {
    expect(citedIndexes('Use arr[0] or [a] or [1.5] or [] or [3-1] or [1 2].', 5)).toEqual([]);
  });
});

describe('isRefusal', () => {
  it('recognises the standard "I don\'t know" answer', () => {
    expect(isRefusal("I don't know based on the provided documents.")).toBe(true);
    expect(isRefusal("  I dont know.")).toBe(true);
  });

  it('does not flag real answers', () => {
    expect(isRefusal('Backups are kept for 30 days [1].')).toBe(false);
  });

  it('accepts a typographic apostrophe', () => {
    expect(isRefusal('I don\u2019t know based on the provided documents.')).toBe(true);
  });

  it('does not flag a partial answer that goes on to cite a passage', () => {
    expect(isRefusal("I don't know the refund window, but invoices go out monthly [1].")).toBe(false);
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
