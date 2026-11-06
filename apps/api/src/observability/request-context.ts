import { AsyncLocalStorage } from 'node:async_hooks';

/** One call to a model provider made while handling a request. Tokens are absent when the provider did not report them. */
export interface ModelCall {
  kind: 'chat' | 'embedding';
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  ms: number;
}

/** What the question pipeline measured. Never holds the question or the answer. */
export interface QueryTelemetry {
  rewriteMs?: number;
  retrieveMs?: number;
  answerMs?: number;
  retrieved?: number;
  citationsMissing?: boolean;
}

export interface RequestContext {
  requestId: string;
  calls: ModelCall[];
  query?: QueryTelemetry;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** True when some call did not report its tokens, so the totals are a lower bound. */
  tokensUnknown: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runInRequestContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn);
/**
 * Run `fn` with no current request. Work started from inside a request that must outlive it (the job queue's
 * drain loop) would otherwise keep that request's context for as long as it runs, and its model calls
 * would be filed under a request that finished long ago.
 */
export const runOutsideRequestContext = <T>(fn: () => T): T => storage.exit(fn);
export const currentRequestContext = (): RequestContext | undefined => storage.getStore();
export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;

/** Record a model call against the current request. A no-op outside a request (scripts, tests, startup seeding). */
export function recordModelCall(call: ModelCall): void {
  storage.getStore()?.calls.push(call);
}

export interface ModelCallHandle {
  /** Fill in what is known when the call ends (or fails); anything omitted stays unknown. */
  finish(fields: { inputTokens?: number; outputTokens?: number }): void;
}

/**
 * Register a model call when it STARTS, tokens unknown, and fill the numbers in with `finish`. The request's
 * access line is written the moment the client's connection closes, which can be before an abandoned or failed
 * call reports back; a call registered up front is still counted then, as unknown tokens, instead of vanishing.
 */
export function startModelCall(call: Pick<ModelCall, 'kind' | 'provider' | 'model'>): ModelCallHandle {
  const started = Date.now();
  const record: ModelCall = { ...call, ms: 0 };
  storage.getStore()?.calls.push(record);
  return {
    finish: (fields) => {
      record.inputTokens = fields.inputTokens;
      record.outputTokens = fields.outputTokens;
      record.ms = Date.now() - started;
    },
  };
}

/** Merge what the question pipeline measured into the current request. */
export function annotateQuery(fields: QueryTelemetry): void {
  const ctx = storage.getStore();
  if (ctx) ctx.query = { ...ctx.query, ...fields };
}

export function summariseCalls(calls: readonly ModelCall[]): UsageSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let tokensUnknown = false;
  for (const c of calls) {
    if (c.inputTokens === undefined || c.outputTokens === undefined) tokensUnknown = true;
    inputTokens += c.inputTokens ?? 0;
    outputTokens += c.outputTokens ?? 0;
  }
  return { calls: calls.length, inputTokens, outputTokens, tokensUnknown };
}
