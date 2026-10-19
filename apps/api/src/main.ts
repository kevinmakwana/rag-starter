import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProviderErrorFilter } from './common/provider-error.filter';
import { APP_CONFIG, AppConfig } from './config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const cfg = app.get<AppConfig>(APP_CONFIG);

  app.enableCors({ origin: cfg.corsOrigin.split(',').map((o) => o.trim()) });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new ProviderErrorFilter());
  app.enableShutdownHooks();

  if (cfg.auth.keys.size === 0) {
    Logger.warn(
      'Authentication is OFF: anyone who can reach this API can read, change and delete every document. ' +
        'Set API_KEYS to require a key (see README).',
      'Bootstrap',
    );
  }

  await app.listen(cfg.port);
  Logger.log(
    `API on http://localhost:${cfg.port} (embeddings: ${cfg.embeddingProvider}, chat: ${cfg.chatProvider})`,
    'Bootstrap',
  );
}

bootstrap();
