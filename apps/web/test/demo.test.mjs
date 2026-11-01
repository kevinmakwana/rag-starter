import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEMO_QUESTIONS } from '../lib/demo.ts';

describe('the demo starter questions', () => {
  it('are a handful of distinct, non-empty questions the API will accept (at most 2,000 characters)', () => {
    assert.ok(DEMO_QUESTIONS.length >= 4 && DEMO_QUESTIONS.length <= 8);
    assert.equal(new Set(DEMO_QUESTIONS).size, DEMO_QUESTIONS.length);
    for (const q of DEMO_QUESTIONS) {
      assert.ok(q.trim().length > 0 && q.length <= 2000, q);
    }
  });

  it('include one the documents cannot answer, to show the refusal', () => {
    assert.ok(DEMO_QUESTIONS.includes('What is the capital of France?'));
  });
});
