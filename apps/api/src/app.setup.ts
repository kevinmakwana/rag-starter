import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
// Express is what @nestjs/platform-express runs on: imported here, not declared again, so there is only one copy.
import { json } from 'express';
import { ProviderErrorFilter } from './common/provider-error.filter';
import { AppConfig } from './config';

/**
 * Document text is capped at 500,000 characters, and JSON escaping can turn one character into six
 * bytes, so Express's 100 kB default would reject documents the API otherwise accepts.
 */
export const DOCUMENT_BODY_LIMIT = '4mb';

/**
 * Everything else stays small. The largest valid question (2,000 characters plus 20 history messages of
 * 4,000) is about 490 kB when every character needs a six-byte escape, so this leaves a little headroom.
 */
export const JSON_BODY_LIMIT = '512kb';

/** Everything main.ts sets up, shared with the tests so they run the same configuration. */
export function configureApp(app: NestExpressApplication, cfg: AppConfig): void {
  app.enableCors({
    origin: cfg.corsOrigin.split(',').map((o) => o.trim()),
    // Browsers hide other response headers from scripts; the web app shows "try again in N seconds".
    exposedHeaders: ['Retry-After'],
  });
  // Trust no proxy unless told to: otherwise anyone could pick their own IP with X-Forwarded-For.
  app.set('trust proxy', cfg.trustProxy);
  // Registered before Nest's own parser, so these routes are parsed (and limited) here; the rest fall through to it.
  app.use(['/documents', '/jobs/documents'], json({ limit: DOCUMENT_BODY_LIMIT }));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ProviderErrorFilter());
}
