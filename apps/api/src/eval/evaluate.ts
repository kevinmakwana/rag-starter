import { RetrievedChunk, sourceLabel } from '../query/prompt';

/** A passage that should answer a question: a document, optionally narrowed to one section. */
export interface Expected {
  title: string;
  section?: string;
}

/** `expected: []` marks a question the documents cannot answer: retrieval should return nothing. */
export interface EvalCase {
  question: string;
  expected: Expected[];
}

export interface EvalFailure {
  question: string;
  /** Labels of what retrieval returned instead, best first. */
  retrieved: string[];
}

export interface EvalReport {
  answerable: number;
  /** Share of answerable questions with a relevant chunk in the top k. */
  hitRate: number;
  /** Share of answerable questions whose first retrieved chunk is relevant. */
  top1Rate: number;
  /** Mean reciprocal rank of the first relevant chunk (0 when absent) over answerable questions. */
  mrr: number;
  unanswerable: number;
  /** Share of unanswerable questions where retrieval correctly returned nothing. */
  abstainRate: number;
  /** Answerable questions where a relevant chunk was retrieved, but not first. */
  misranked: EvalFailure[];
  failures: EvalFailure[];
}

/** Headings may be a path ("Doc › Section"), so the expected section only has to be the last part. */
export function isRelevant(chunk: Pick<RetrievedChunk, 'title' | 'heading'>, expected: Expected): boolean {
  if (chunk.title !== expected.title) return false;
  if (!expected.section) return true;
  const heading = chunk.heading ?? '';
  return heading === expected.section || heading.endsWith(` › ${expected.section}`);
}

export function reciprocalRank(retrieved: RetrievedChunk[], expected: Expected[]): number {
  const index = retrieved.findIndex((chunk) => expected.some((e) => isRelevant(chunk, e)));
  return index === -1 ? 0 : 1 / (index + 1);
}

const mean = (values: number[]): number => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

export async function evaluate(
  retrieve: (question: string, k: number) => Promise<RetrievedChunk[]>,
  dataset: EvalCase[],
  k: number,
): Promise<EvalReport> {
  const hits: number[] = [];
  const ranks: number[] = [];
  const abstains: number[] = [];
  const failures: EvalFailure[] = [];
  const misranked: EvalFailure[] = [];

  for (const { question, expected } of dataset) {
    const retrieved = (await retrieve(question, k)).slice(0, k);
    if (expected.length === 0) {
      abstains.push(retrieved.length === 0 ? 1 : 0);
      if (retrieved.length) failures.push({ question, retrieved: retrieved.map(sourceLabel) });
      continue;
    }
    const rr = reciprocalRank(retrieved, expected);
    hits.push(rr > 0 ? 1 : 0);
    ranks.push(rr);
    if (rr === 0) failures.push({ question, retrieved: retrieved.map(sourceLabel) });
    else if (rr < 1) misranked.push({ question, retrieved: retrieved.map(sourceLabel) });
  }

  return {
    answerable: hits.length,
    hitRate: mean(hits),
    top1Rate: mean(ranks.map((rr) => (rr === 1 ? 1 : 0))),
    mrr: mean(ranks),
    unanswerable: abstains.length,
    abstainRate: mean(abstains),
    misranked,
    failures,
  };
}
