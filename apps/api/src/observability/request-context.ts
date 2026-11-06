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
export const currentRequestContext = (): RequestContext | undefined => storage.getStore();
export const currentRequestId = (): string | undefined => storage.getStore()?.requestId;

/** Record a model call against the current request. A no-op outside a request (scripts, tests, startup seeding). */
export function recordModelCall(call: ModelCall): void {
  storage.getStore()?.calls.push(call);
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
