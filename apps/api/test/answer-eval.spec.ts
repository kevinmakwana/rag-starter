import {
  answerThresholdsMissed,
  AnswerReport,
  evaluateAnswers,
  EvalCase,
  parseRate,
  forTerminal,
  parseRateFlag,
} from '../src/eval/evaluate';
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

    const halfGrounded = report.failures.find((f) => f.question === 'half grounded')!;
    expect(report.failures.map((f) => f.reason).sort()).toEqual(['missed-refusal', 'unsupported', 'unsupported', 'wrong-refusal']);
    expect(halfGrounded.unsupported).toEqual(['Refunds take 5 days']);
    expect(halfGrounded.answer).toBe('Monthly [1]. Refunds take 5 days [1].');
  });

  it('lists the worst answers first: refusal failures and fully unsupported answers before partly supported ones', async () => {
    const report = await evaluateAnswers(ask, stubJudge().judge, dataset);

    expect(report.failures.map((f) => f.question)).toEqual([
      'wrongly refuses',
      'uncited',
      'should have refused',
      'half grounded',
    ]);
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

  it('keeps the original error as the cause and copes with non-Error throws', async () => {
    const original = new Error('429 rate limited');
    const error = await evaluateAnswers(
      async () => {
        throw original;
      },
      stubJudge().judge,
      dataset,
    ).catch((e) => e);
    expect(error.cause).toBe(original);

    await expect(
      evaluateAnswers(
        async () => {
          throw 'boom';
        },
        stubJudge().judge,
        dataset,
      ),
    ).rejects.toThrow('Answering "grounded" failed: boom');
  });
});

describe('forTerminal', () => {
  it('collapses whitespace and replaces control characters, including escape sequences', () => {
    expect(forTerminal('a\n\tb   c')).toBe('a b c');
    expect(forTerminal('red \u001b[31mtext\u001b[0m\r\u0007done')).toBe('red [31mtext [0m done');
    expect(forTerminal('\u009b2Jx')).toBe('2Jx');
  });

  it('truncates to the limit when given one', () => {
    expect(forTerminal('abcdef', 3)).toBe('abc');
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

describe('parseRateFlag', () => {
  it('reads --name=value and ignores other arguments', () => {
    expect(parseRateFlag('min-grounded', ['--answers', '--min-grounded=0.9', '--k=3'])).toBe(0.9);
    expect(parseRateFlag('min-grounded', ['--answers'])).toBeUndefined();
  });

  it('rejects a bare flag or a space-separated value instead of silently skipping the gate', () => {
    expect(() => parseRateFlag('min-grounded', ['--answers', '--min-grounded'])).toThrow(
      /--min-grounded needs a value.*--min-grounded=0\.9/,
    );
    expect(() => parseRateFlag('min-grounded', ['--answers', '--min-grounded', '0.9'])).toThrow(/needs a value/);
  });

  it('still validates the value', () => {
    expect(() => parseRateFlag('min-refusal', ['--min-refusal=1.5'])).toThrow(/--min-refusal must be a number/);
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

  it('counts unjudged answers against the groundedness gate so a failing judge cannot pass it', () => {
    // 1 of 21 answers judged (and fully supported): the reported 100% says nothing about the other 20.
    const missed = answerThresholdsMissed(report({ judged: 1, unjudged: 20, groundedness: 1 }), { minGrounded: 0.9 });

    expect(missed).toEqual([
      'groundedness 4.8% is below --min-grounded=0.9 (counting 20 unjudged answers as ungrounded)',
    ]);
  });

  it('only lowers the gate in proportion to how many answers went unjudged', () => {
    const report20of21 = report({ judged: 20, unjudged: 1, groundedness: 1 });

    expect(answerThresholdsMissed(report20of21, { minGrounded: 0.9 })).toEqual([]);
    expect(answerThresholdsMissed(report20of21, { minGrounded: 0.96 })).toHaveLength(1);
  });
});
