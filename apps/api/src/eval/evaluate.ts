import { isRefusal, RetrievedChunk, sourceLabel } from '../query/prompt';
import type { AnsweredQuestion } from '../query/query.service';
import type { Judge } from './judge';

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

export interface AnswerFailure {
  question: string;
  reason: 'unsupported' | 'wrong-refusal' | 'missed-refusal';
  answer: string;
  /** Claims the judge found unsupported (empty for the refusal reasons). */
  unsupported: string[];
}

export interface AnswerReport {
  answerable: number;
  unanswerable: number;
  /** Answers the judge returned a usable verdict for. */
  judged: number;
  /** Answers excluded from the scores because the judge failed or returned nothing usable. */
  unjudged: number;
  unjudgedQuestions: string[];
  /** Mean share of claims the judge found supported, over judged answers. */
  groundedness: number;
  /** Share of judged answers where every claim is supported. */
  fullyGrounded: number;
  /** Share of non-refusing answers to answerable questions that cite at least one passage. */
  citationRate: number;
  /** Share of answerable questions refused although a relevant passage was retrieved. */
  wrongRefusals: number;
  /** Share of unanswerable questions the answer correctly refused. */
  refusalRate: number;
  failures: AnswerFailure[];
}

/**
 * Run each question through the real pipeline and score the answer. Answerable questions that get an
 * answer are judged for groundedness; unanswerable ones only check that the model refused. A refusal
 * on an answerable question is a wrong refusal only if retrieval had found the right passage,
 * otherwise it is a retrieval miss, which the retrieval eval already reports.
 */
export async function evaluateAnswers(
  ask: (question: string) => Promise<AnsweredQuestion>,
  judge: Judge,
  dataset: EvalCase[],
): Promise<AnswerReport> {
  const fractions: number[] = [];
  const fully: number[] = [];
  const cited: number[] = [];
  const wrongRefusals: number[] = [];
  const refusals: number[] = [];
  const failures: { failure: AnswerFailure; score: number }[] = [];
  const unjudgedQuestions: string[] = [];

  for (const { question, expected } of dataset) {
    let asked: AnsweredQuestion;
    try {
      asked = await ask(question);
    } catch (err) {
      throw new Error(`Answering "${question}" failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const { result, passages } = asked;
    const refused = isRefusal(result.answer);

    if (expected.length === 0) {
      refusals.push(refused ? 1 : 0);
      if (!refused) failures.push({ failure: { question, reason: 'missed-refusal', answer: result.answer, unsupported: [] }, score: 0 });
      continue;
    }

    if (refused) {
      const retrievedRelevant = passages.some((chunk) => expected.some((e) => isRelevant(chunk, e)));
      wrongRefusals.push(retrievedRelevant ? 1 : 0);
      if (retrievedRelevant) {
        failures.push({ failure: { question, reason: 'wrong-refusal', answer: result.answer, unsupported: [] }, score: 0 });
      }
      continue;
    }

    wrongRefusals.push(0);
    cited.push(result.meta.citationsMissing ? 0 : 1);

    const verdict = await judge.judge(question, result.answer, passages);
    if (!verdict || verdict.claims.length === 0) {
      unjudgedQuestions.push(question);
      continue;
    }
    const unsupported = verdict.claims.filter((c) => !c.supported).map((c) => c.claim);
    const fraction = (verdict.claims.length - unsupported.length) / verdict.claims.length;
    fractions.push(fraction);
    fully.push(unsupported.length === 0 ? 1 : 0);
    if (unsupported.length) {
      failures.push({ failure: { question, reason: 'unsupported', answer: result.answer, unsupported }, score: fraction });
    }
  }

  return {
    answerable: wrongRefusals.length,
    unanswerable: refusals.length,
    judged: fractions.length,
    unjudged: unjudgedQuestions.length,
    unjudgedQuestions,
    groundedness: mean(fractions),
    fullyGrounded: mean(fully),
    citationRate: mean(cited),
    wrongRefusals: mean(wrongRefusals),
    refusalRate: mean(refusals),
    // Worst first: a wrong or missed refusal counts as 0% right; ties keep dataset order (sort is stable).
    failures: failures.sort((a, b) => a.score - b.score).map((f) => f.failure),
  };
}

/** Answers and claims are model output: make them safe and short to print (no escape sequences, one line). */
export function forTerminal(text: string, max = Infinity): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim().slice(0, max);
}

/** A `--min-*` flag value: absent, or a number from 0 to 1. Anything else is an error, not a skipped gate. */
export function parseRate(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`--${name} must be a number between 0 and 1 (got "${raw}")`);
  }
  return n;
}

/**
 * Read `--name=value` from argv. A bare `--name` (or `--name 0.9`) is an error: `--name=` is the only
 * accepted form, and ignoring the other spellings would silently turn a CI gate off.
 */
export function parseRateFlag(name: string, argv: string[]): number | undefined {
  if (argv.includes(`--${name}`)) {
    throw new Error(`--${name} needs a value: use --${name}=0.9`);
  }
  const prefix = `--${name}=`;
  return parseRate(name, argv.find((a) => a.startsWith(prefix))?.slice(prefix.length));
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Human-readable list of the answer thresholds the report missed; empty when all are met. */
export function answerThresholdsMissed(
  report: AnswerReport,
  { minGrounded, minRefusal }: { minGrounded?: number; minRefusal?: number },
): string[] {
  const missed: string[] = [];
  // The reported groundedness leaves unjudged answers out, but the gate must not: a judge that fails
  // on 20 of 21 answers would otherwise gate on the one that worked. So for the gate they count as 0.
  const attempted = report.judged + report.unjudged;
  const gated = attempted ? (report.groundedness * report.judged) / attempted : 0;
  if (minGrounded !== undefined && gated < minGrounded) {
    const note = report.unjudged ? ` (counting ${report.unjudged} unjudged answers as ungrounded)` : '';
    missed.push(`groundedness ${pct(gated)} is below --min-grounded=${minGrounded}${note}`);
  }
  if (minRefusal !== undefined && report.refusalRate < minRefusal) {
    missed.push(`refusal rate ${pct(report.refusalRate)} is below --min-refusal=${minRefusal}`);
  }
  return missed;
}
