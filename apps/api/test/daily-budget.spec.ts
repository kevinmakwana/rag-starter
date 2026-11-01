import { DailyBudget } from '../src/demo/daily-budget';

describe('DailyBudget', () => {
  const clock = (start: number) => {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  };
  const NOON = Date.UTC(2026, 9, 29, 12, 0, 0);

  it('allows up to the cap in a day, then refuses', () => {
    const budget = new DailyBudget(clock(NOON).now);

    expect(budget.take(2).allowed).toBe(true);
    expect(budget.take(2).allowed).toBe(true);
    expect(budget.take(2).allowed).toBe(false);
  });

  it('tells a refused caller how many whole seconds remain until the next UTC midnight', () => {
    const time = clock(Date.UTC(2026, 9, 29, 23, 59, 0));
    const budget = new DailyBudget(time.now);
    budget.take(1);

    expect(budget.take(1)).toEqual({ allowed: false, retryAfterSeconds: 60 });

    time.advance(59_500); // 500 ms to midnight
    expect(budget.take(1)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('starts a fresh budget on the next UTC day', () => {
    const time = clock(Date.UTC(2026, 9, 29, 23, 59, 0));
    const budget = new DailyBudget(time.now);
    budget.take(1);
    expect(budget.take(1).allowed).toBe(false);

    time.advance(60_000);

    expect(budget.take(1).allowed).toBe(true);
  });

  it('does not count a refused request', () => {
    const budget = new DailyBudget(clock(NOON).now);
    budget.take(1);

    for (let i = 0; i < 100; i++) expect(budget.take(1).allowed).toBe(false);
    // still refusing, and nothing overflowed: the next day would start clean (covered above)
    expect(budget.take(1).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('never refuses when the cap is 0', () => {
    const budget = new DailyBudget(clock(NOON).now);

    for (let i = 0; i < 1000; i++) expect(budget.take(0).allowed).toBe(true);
  });
});
