import { Logger } from '@nestjs/common';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { QueryTelemetry, RequestContext, UsageSummary, runInRequestContext, summariseCalls } from './request-context';

export type LogFormat = 'text' | 'json';
export type LogSink = (line: string) => void;

/** A client-supplied id is only kept when it is plain and short; anything else could forge or flood log lines. */
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export interface AccessLogEntry {
  requestId: string;
  method: string;
  /** The route pattern ("/documents/:id"), never the real path, so ids and query strings stay out of the log. */
  route: string;
  status: number;
  durationMs: number;
  /** The client went away before the response finished. */
  aborted: boolean;
  usage?: UsageSummary;
  query?: QueryTelemetry;
}

export function formatText(entry: AccessLogEntry): string {
  const parts = [`${entry.method} ${entry.route} ${entry.status} ${entry.durationMs}ms`, `req=${entry.requestId}`];
  if (entry.aborted) parts.push('aborted');
  if (entry.usage) {
    const { calls, inputTokens, outputTokens, tokensUnknown } = entry.usage;
    parts.push(`model-calls=${calls}`, `tokens=${inputTokens}/${outputTokens}${tokensUnknown ? '+' : ''}`);
  }
  return parts.join(' ');
}

function routeOf(req: Request): string {
  const path = req.route?.path;
  return typeof path === 'string' ? `${req.baseUrl}${path}` : '(unmatched)';
}

const stdout: LogSink = (line) => void process.stdout.write(`${line}\n`);
const http = new Logger('http');

/**
 * Gives each request an id (header `X-Request-Id`), opens its context, and writes one access line when the
 * response closes. In JSON the line uses the same keys as Nest's own JSON logger (level, pid, timestamp,
 * context, message) plus the fields above, so one `jq` filter works across the whole log.
 */
export function accessLogMiddleware(format: LogFormat, sink: LogSink = stdout): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const supplied = req.get('x-request-id');
    const requestId = supplied && CLIENT_REQUEST_ID.test(supplied) ? supplied : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const ctx: RequestContext = { requestId, calls: [] };
    const started = process.hrtime.bigint();

    res.once('close', () => {
      const route = routeOf(req);
      // Healthchecks poll every few seconds; only a failing one is worth a line.
      if (route === '/health' && res.statusCode < 400) return;
      const entry: AccessLogEntry = {
        requestId,
        method: req.method,
        route,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        aborted: !res.writableFinished,
        ...(ctx.calls.length ? { usage: summariseCalls(ctx.calls) } : {}),
        ...(ctx.query ? { query: ctx.query } : {}),
      };
      if (format === 'json') {
        sink(
          JSON.stringify({
            level: 'log',
            pid: process.pid,
            timestamp: Date.now(),
            context: 'http',
            message: 'request',
            ...entry,
          }),
        );
      } else {
        http.log(formatText(entry));
      }
    });

    runInRequestContext(ctx, next);
  };
}
