import {
  ModelCall,
  RequestContext,
  annotateQuery,
  currentRequestContext,
  recordModelCall,
  runInRequestContext,
  summariseCalls,
} from '../src/observability/request-context';

const call = (over: Partial<ModelCall> = {}): ModelCall => ({
  kind: 'chat',
  provider: 'p',
  model: 'm',
  inputTokens: 10,
  outputTokens: 5,
  ms: 1,
  ...over,
});

describe('request context', () => {
  it('records nothing outside a request (scripts, tests, startup seeding)', () => {
    expect(() => recordModelCall(call())).not.toThrow();
    expect(() => annotateQuery({ retrieved: 1 })).not.toThrow();
    expect(currentRequestContext()).toBeUndefined();
  });

  it('collects model calls and query telemetry for the current request', () => {
    const ctx: RequestContext = { requestId: 'r1', calls: [] };
    runInRequestContext(ctx, () => {
      recordModelCall(call());
      annotateQuery({ retrieveMs: 4 });
      annotateQuery({ retrieved: 3 });
    });
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.query).toEqual({ retrieveMs: 4, retrieved: 3 });
  });

  it('keeps simultaneous requests apart', async () => {
    const a: RequestContext = { requestId: 'a', calls: [] };
    const b: RequestContext = { requestId: 'b', calls: [] };
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await Promise.all([
      runInRequestContext(a, async () => {
        await pause(15);
        recordModelCall(call({ inputTokens: 1 }));
      }),
      runInRequestContext(b, async () => {
        recordModelCall(call({ inputTokens: 2 }));
        await pause(30);
        recordModelCall(call({ inputTokens: 3 }));
      }),
    ]);
    expect(a.calls.map((c) => c.inputTokens)).toEqual([1]);
    expect(b.calls.map((c) => c.inputTokens)).toEqual([2, 3]);
  });
});

describe('summariseCalls', () => {
  it('adds up tokens across calls', () => {
    expect(summariseCalls([call(), call({ inputTokens: 20, outputTokens: 7 })])).toEqual({
      calls: 2,
      inputTokens: 30,
      outputTokens: 12,
      tokensUnknown: false,
    });
  });

  it('says so when any call did not report its tokens, instead of counting it as zero', () => {
    const s = summariseCalls([call(), call({ inputTokens: undefined, outputTokens: undefined })]);
    expect(s).toMatchObject({ calls: 2, inputTokens: 10, outputTokens: 5, tokensUnknown: true });
  });

  it('is empty for no calls', () => {
    expect(summariseCalls([])).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, tokensUnknown: false });
  });
});
