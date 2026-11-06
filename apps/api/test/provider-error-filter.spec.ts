import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { ProviderErrorFilter } from '../src/common/provider-error.filter';
import { RequestContext, runInRequestContext } from '../src/observability/request-context';

describe('ProviderErrorFilter', () => {
  const logged: string[] = [];
  beforeEach(() => {
    logged.length = 0;
    Logger.overrideLogger({
      log: () => undefined,
      warn: () => undefined,
      error: (message: unknown) => void logged.push(String(message)),
    });
  });
  afterEach(() => Logger.overrideLogger(new ConsoleLogger()));

  const fakeHost = () => {
    const sent: { status?: number; body?: any } = {};
    const res = {
      status: (s: number) => ((sent.status = s), res),
      json: (b: any) => (sent.body = b),
    };
    return { sent, host: { switchToHttp: () => ({ getResponse: () => res }) } as any };
  };
  const providerError = () => new OpenAI.APIError(429, {}, 'rate limited', new Headers());

  it('puts the request id in the log line, so the error can be matched to its access line', () => {
    const { sent, host } = fakeHost();
    const ctx: RequestContext = { requestId: 'req-abc12345', calls: [] };
    runInRequestContext(ctx, () => new ProviderErrorFilter().catch(providerError() as any, host));
    expect(sent.status).toBe(502);
    expect(logged[0]).toContain('req=req-abc12345');
  });

  it('still logs and answers 502 outside a request', () => {
    const { sent, host } = fakeHost();
    new ProviderErrorFilter().catch(providerError() as any, host);
    expect(sent.status).toBe(502);
    expect(logged[0]).toContain('req=-');
  });
});
