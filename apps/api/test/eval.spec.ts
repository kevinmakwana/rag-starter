import { evaluate, EvalCase, isRelevant, reciprocalRank } from '../src/eval/evaluate';
import { RetrievedChunk } from '../src/query/prompt';

const chunk = (title: string, heading: string | null): RetrievedChunk => ({
  chunkId: '1',
  documentId: '00000000-0000-0000-0000-000000000000',
  title,
  heading,
  content: 'x',
  score: 0.9,
});

describe('isRelevant', () => {
  it('matches on document title and section', () => {
    expect(isRelevant(chunk('FAQ', 'Billing'), { title: 'FAQ', section: 'Billing' })).toBe(true);
    expect(isRelevant(chunk('FAQ', 'Support'), { title: 'FAQ', section: 'Billing' })).toBe(false);
    expect(isRelevant(chunk('Handbook', 'Billing'), { title: 'FAQ', section: 'Billing' })).toBe(false);
  });

  it('accepts a heading path that ends with the expected section', () => {
    expect(isRelevant(chunk('FAQ', 'FAQ › Billing'), { title: 'FAQ', section: 'Billing' })).toBe(true);
    expect(isRelevant(chunk('FAQ', 'FAQ › Not Billing'), { title: 'FAQ', section: 'Billing' })).toBe(false);
  });
});

describe('reciprocalRank', () => {
  const expected = [{ title: 'FAQ', section: 'Billing' }];

  it('is 1 / rank of the first relevant chunk', () => {
    expect(reciprocalRank([chunk('FAQ', 'Support'), chunk('FAQ', 'Billing')], expected)).toBe(0.5);
    expect(reciprocalRank([chunk('FAQ', 'Billing')], expected)).toBe(1);
  });

  it('is 0 when nothing relevant was retrieved', () => {
    expect(reciprocalRank([chunk('FAQ', 'Support')], expected)).toBe(0);
    expect(reciprocalRank([], expected)).toBe(0);
  });
});

describe('evaluate', () => {
  const dataset: EvalCase[] = [
    { question: 'rank one', expected: [{ title: 'FAQ', section: 'Billing' }] },
    { question: 'rank two', expected: [{ title: 'FAQ', section: 'Support' }] },
    { question: 'miss', expected: [{ title: 'FAQ', section: 'Refunds' }] },
    { question: 'should find nothing', expected: [] },
    { question: 'wrongly finds something', expected: [] },
  ];

  const retrieved: Record<string, RetrievedChunk[]> = {
    'rank one': [chunk('FAQ', 'Billing')],
    'rank two': [chunk('FAQ', 'Billing'), chunk('FAQ', 'Support')],
    miss: [chunk('FAQ', 'Billing')],
    'should find nothing': [],
    'wrongly finds something': [chunk('FAQ', 'Billing')],
  };
  const retrieve = async (question: string) => retrieved[question];

  it('reports hit rate and MRR over answerable questions and abstention over the rest', async () => {
    const report = await evaluate(retrieve, dataset, 5);

    expect(report.answerable).toBe(3);
    expect(report.hitRate).toBeCloseTo(2 / 3, 5);
    expect(report.top1Rate).toBeCloseTo(1 / 3, 5); // only "rank one" has the right chunk first
    expect(report.mrr).toBeCloseTo((1 + 0.5 + 0) / 3, 5);
    expect(report.unanswerable).toBe(2);
    expect(report.abstainRate).toBe(0.5);
  });

  it('only counts hits inside the top k', async () => {
    const report = await evaluate(retrieve, dataset, 1);
    expect(report.hitRate).toBeCloseTo(1 / 3, 5);
  });

  it('lists questions whose answer was found but not ranked first', async () => {
    const report = await evaluate(retrieve, dataset, 5);
    expect(report.misranked).toEqual([{ question: 'rank two', retrieved: ['FAQ — Billing', 'FAQ — Support'] }]);
  });

  it('lists the questions that missed, with what was retrieved instead', async () => {
    const report = await evaluate(retrieve, dataset, 5);
    expect(report.failures.map((f) => f.question)).toEqual(['miss', 'wrongly finds something']);
    expect(report.failures[0].retrieved).toEqual(['FAQ — Billing']);
  });
});
