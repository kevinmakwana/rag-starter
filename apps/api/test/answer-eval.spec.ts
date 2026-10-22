import { answerThresholdsMissed, AnswerReport, evaluateAnswers, EvalCase, parseRate } from '../src/eval/evaluate';
import type { Judge, Verdict } from '../src/eval/judge';
import { RetrievedChunk } from '../src/query/prompt';
import type { AnsweredQuestion, QueryResult } from '../src/query/query.service';

const chunk = (title: string, heading: string | null): RetrievedChunk => ({
  chunkId: '1',
  documentId: '00000000-0000-0000-0000-000000000000',
  title,
  heading,
  content: 'full passage text',
  score: 0.9,
});

const REFUSAL = "I don't know based on the provided documents.";

const asked = (answer: string, passages: RetrievedChunk[], citationsMissing = false): AnsweredQuestion => ({
  result: { answer, sources: [], meta: citationsMissing ? { citationsMissing: true } : {} } as unknown as QueryResult,
  passages,
});

const billing = chunk('FAQ', 'Billing');
const billingCase = [{ title: 'FAQ', section: 'Billing' }];

const dataset: EvalCase[] = [
  { question: 'grounded', expected: billingCase },
  { question: 'half grounded', expected: billingCase },
  { question: 'wrongly refuses', expected: billingCase },
  { question: 'retrieval missed and refused', expected: [{ title: 'FAQ', section: 'Support' }] },
  { question: 'uncited', expected: billingCase },
  { question: 'unjudgeable', expected: billingCase },
  { question: 'correctly refuses', expected: [] },
  { question: 'should have refused', expected: [] },
];

const answers: Record<string, AnsweredQuestion> = {
  grounded: asked('Invoices go out monthly [1].', [billing]),
  'half grounded': asked('Monthly [1]. Refunds take 5 days [1].', [billing]),
  'wrongly refuses': asked(REFUSAL, [billing]),
  'retrieval missed and refused': asked(REFUSAL, [billing]),
  uncited: asked('Invoices go out monthly.', [billing], true),
  unjudgeable: asked('Something [1].', [billing]),
  'correctly refuses': asked(REFUSAL, []),
  'should have refused': asked('Made up answer [1].', [billing]),
};

const verdicts: Record<string, Verdict | null> = {
  grounded: { claims: [{ claim: 'Invoices go out monthly', supported: true }] },
  'half grounded': {
    claims: [
      { claim: 'Monthly', supported: true },
      { claim: 'Refunds take 5 days', supported: false },
    ],
  },
  uncited: { claims: [{ claim: 'Invoices go out monthly', supported: false }] },
  unjudgeable: null,
};

function stubJudge() {
  const seen: { question: string; passages: RetrievedChunk[] }[] = [];
  const judge: Judge = {
    async judge(question, _answer, passages) {
      seen.push({ question, passages });
      return verdicts[question] ?? null;
    },
  };
  return { judge, seen };
}

describe('evaluateAnswers', () => {
  const ask = async (question: string) => answers[question];

  it('scores groundedness, citations and refusals', async () => {
    const report = await evaluateAnswers(ask, stubJudge().judge, dataset);

    expect(report.answerable).toBe(6);
    expect(report.unanswerable).toBe(2);
    expect(report.judged).toBe(3);
    expect(report.groundedness).toBeCloseTo((1 + 0.5 + 0) / 3, 5);
    expect(report.fullyGrounded).toBeCloseTo(1 / 3, 5);
    expect(report.citationRate).toBeCloseTo(3 / 4, 5); // 4 non-refusals, only "uncited" lacks a citation
    expect(report.wrongRefusals).toBeCloseTo(1 / 6, 5);
    expect(report.refusalRate).toBe(0.5);
  });

  it('counts unusable verdicts as unjudged instead of scoring them', async () => {
    const report = await evaluateAnswers(ask, stubJudge().judge, dataset);

    expect(report.unjudged).toBe(1);
    expect(report.unjudgedQuestions).toEqual(['unjudgeable']);
  });

  it('treats a verdict with no claims as unjudged', async () => {
    const empty: Judge = { judge: async () => ({ claims: [] }) };

    const report = await evaluateAnswers(ask, empty, [dataset[0]]);

    expect(report.judged).toBe(0);
    expect(report.unjudged).toBe(1);
  });

  it('lists what went wrong, with unsupported claims quoted', async () => {
    const report = await evaluateAnswers(ask, stubJudge().judge, dataset);

    expect(report.failures.map((f) => [f.question, f.reason])).toEqual([
      ['half grounded', 'unsupported'],
      ['wrongly refuses', 'wrong-refusal'],
      ['uncited', 'unsupported'],
      ['should have refused', 'missed-refusal'],
    ]);
    expect(report.failures[0].unsupported).toEqual(['Refunds take 5 days']);
    expect(report.failures[0].answer).toBe('Monthly [1]. Refunds take 5 days [1].');
  });

  it('does not call it a wrong refusal when retrieval itself missed', async () => {
    const report = await evaluateAnswers(ask, stubJudge().judge, [dataset[3]]);

    expect(report.wrongRefusals).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it('only asks the judge about answered, answerable questions, and gives it the full passages', async () => {
    const { judge, seen } = stubJudge();

    await evaluateAnswers(ask, judge, dataset);

    expect(seen.map((s) => s.question)).toEqual(['grounded', 'half grounded', 'uncited', 'unjudgeable']);
    expect(seen[0].passages).toEqual([billing]);
  });

  it('reports zeros, not NaN, for an empty dataset or one with no answerable questions', async () => {
    const { judge } = stubJudge();
    const zeros = {
      answerable: 0,
      judged: 0,
      unjudged: 0,
      groundedness: 0,
      fullyGrounded: 0,
      citationRate: 0,
      wrongRefusals: 0,
    };

    expect(await evaluateAnswers(ask, judge, [])).toMatchObject({ ...zeros, unanswerable: 0, refusalRate: 0 });
    expect(await evaluateAnswers(ask, judge, [dataset[6]])).toMatchObject({ ...zeros, unanswerable: 1, refusalRate: 1 });
  });

  it('fails loudly, naming the question, when answering throws', async () => {
    const failing = async (): Promise<AnsweredQuestion> => {
      throw new Error('429 rate limited');
    };

    await expect(evaluateAnswers(failing, stubJudge().judge, dataset)).rejects.toThrow(
      'Answering "grounded" failed: 429 rate limited',
    );
  });
});

describe('parseRate', () => {
  it('passes through absent values and numbers between 0 and 1', () => {
    expect(parseRate('min-grounded', undefined)).toBeUndefined();
    expect(parseRate('min-grounded', '0.9')).toBe(0.9);
    expect(parseRate('min-grounded', '0')).toBe(0);
    expect(parseRate('min-grounded', '1')).toBe(1);
  });

  it('rejects anything else with the flag name in the message', () => {
    for (const raw of ['abc', '', ' ', '1.5', '-0.1', 'NaN', 'Infinity']) {
      expect(() => parseRate('min-grounded', raw)).toThrow(/--min-grounded must be a number between 0 and 1/);
    }
  });
});

describe('answerThresholdsMissed', () => {
  const report = (over: Partial<AnswerReport>): AnswerReport => ({
    answerable: 1,
    unanswerable: 1,
    judged: 1,
    unjudged: 0,
    unjudgedQuestions: [],
    groundedness: 0.8,
    fullyGrounded: 0.5,
    citationRate: 1,
    wrongRefusals: 0,
    refusalRate: 0.5,
    failures: [],
    ...over,
  });

  it('is empty when every threshold is met or unset', () => {
    expect(answerThresholdsMissed(report({}), {})).toEqual([]);
    expect(answerThresholdsMissed(report({}), { minGrounded: 0.8, minRefusal: 0.5 })).toEqual([]);
  });

  it('names each missed threshold', () => {
    const missed = answerThresholdsMissed(report({}), { minGrounded: 0.9, minRefusal: 0.6 });

    expect(missed).toEqual([
      'groundedness 80.0% is below --min-grounded=0.9',
      'refusal rate 50.0% is below --min-refusal=0.6',
    ]);
  });

  it('fails a groundedness gate when nothing could be judged', () => {
    const missed = answerThresholdsMissed(report({ judged: 0, unjudged: 3, groundedness: 0 }), { minGrounded: 0.5 });

    expect(missed).toHaveLength(1);
  });
});
