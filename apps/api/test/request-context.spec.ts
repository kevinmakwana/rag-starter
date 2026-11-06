import {
  ModelCall,
  RequestContext,
  annotateQuery,
  currentRequestContext,
  recordModelCall,
  runInRequestContext,
  runOutsideRequestContext,
  startModelCall,
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

describe('startModelCall', () => {
  it('shows a call as soon as it starts, with its tokens unknown, and fills them in when it finishes', () => {
    const ctx: RequestContext = { requestId: 'r1', calls: [] };
    runInRequestContext(ctx, () => {
      const handle = startModelCall({ kind: 'chat', provider: 'p', model: 'm' });
      // A reader that looks now (the request line of a client that already left) still sees the call.
      expect(ctx.calls).toHaveLength(1);
      expect(summariseCalls(ctx.calls)).toMatchObject({ calls: 1, tokensUnknown: true });

      handle.finish({ inputTokens: 7, outputTokens: 3 });
      expect(ctx.calls[0]).toMatchObject({ inputTokens: 7, outputTokens: 3 });
      expect(ctx.calls[0].ms).toBeGreaterThanOrEqual(0);
      expect(summariseCalls(ctx.calls)).toMatchObject({ calls: 1, inputTokens: 7, outputTokens: 3, tokensUnknown: false });
    });
  });

  it('can finish with nothing known (a failed call)', () => {
    const ctx: RequestContext = { requestId: 'r1', calls: [] };
    runInRequestContext(ctx, () => startModelCall({ kind: 'chat', provider: 'p', model: 'm' }).finish({}));
    expect(summariseCalls(ctx.calls)).toMatchObject({ calls: 1, tokensUnknown: true });
  });

  it('is a no-op outside a request', () => {
    expect(() => startModelCall({ kind: 'chat', provider: 'p', model: 'm' }).finish({ inputTokens: 1 })).not.toThrow();
  });
});

describe('runOutsideRequestContext', () => {
  it('hides the current request, so work started from a request (a background job) is not attributed to it', async () => {
    const ctx: RequestContext = { requestId: 'r1', calls: [] };
    await runInRequestContext(ctx, async () => {
      await runOutsideRequestContext(async () => {
        await Promise.resolve();
        expect(currentRequestContext()).toBeUndefined();
        recordModelCall(call());
      });
      expect(currentRequestContext()).toBe(ctx);
    });
    expect(ctx.calls).toHaveLength(0);
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
