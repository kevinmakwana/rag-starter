import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { APP_CONFIG, AppConfig } from './config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const cfg = app.get<AppConfig>(APP_CONFIG);

  configureApp(app, cfg);
  app.enableShutdownHooks();

  if (cfg.trustProxy === true) {
    Logger.warn(
      'TRUST_PROXY=true trusts every X-Forwarded-For entry, so a client can choose its own rate-limit bucket ' +
        'unless your proxy overwrites that header. Prefer the number of proxies in front of the API (TRUST_PROXY=1).',
      'Bootstrap',
    );
  }

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
