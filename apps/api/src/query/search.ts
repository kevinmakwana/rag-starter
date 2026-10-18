/** Turn free text into a tsquery that matches passages containing ANY of its words. */
export function toOrTsQuery(text: string): string {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' | ');
}

export interface Fused<T> {
  item: T;
  score: number;
}

/**
 * Reciprocal rank fusion: merge several best-first lists into one. Each list contributes
 * 1 / (k + rank) per item, so an item ranked well by more than one retriever wins, and the
 * scores of the individual retrievers (which aren't comparable) never need to be compared.
 */
export function reciprocalRankFusion<T extends { chunkId: string }>(lists: T[][], k = 60): Fused<T>[] {
  const fused = new Map<string, Fused<T>>();
  for (const list of lists) {
    list.forEach((item, index) => {
      const entry = fused.get(item.chunkId) ?? { item, score: 0 };
      entry.score += 1 / (k + index + 1);
      fused.set(item.chunkId, entry);
    });
  }
  // Array.sort is stable, so ties keep first-seen order.
  return [...fused.values()].sort((a, b) => b.score - a.score);
}
