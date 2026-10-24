import { ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ProviderErrorFilter } from './common/provider-error.filter';
import { AppConfig } from './config';

/**
 * Document text is capped at 500,000 characters, and JSON escaping can turn one character into six
 * bytes, so Express's 100 kB default would reject documents the API otherwise accepts.
 */
export const JSON_BODY_LIMIT = '4mb';

/** Everything main.ts sets up, shared with the tests so they run the same configuration. */
export function configureApp(app: NestExpressApplication, cfg: AppConfig): void {
  app.enableCors({
    origin: cfg.corsOrigin.split(',').map((o) => o.trim()),
    // Browsers hide other response headers from scripts; the web app shows "try again in N seconds".
    exposedHeaders: ['Retry-After'],
  });
  // Trust no proxy unless told to: otherwise anyone could pick their own IP with X-Forwarded-For.
  app.set('trust proxy', cfg.trustProxy);
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ProviderErrorFilter());
}
