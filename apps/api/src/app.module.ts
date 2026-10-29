import { Controller, Get, Inject, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { Public } from './auth/public.decorator';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { DocumentsModule } from './documents/documents.module';
import { DocumentsService } from './documents/documents.service';
import { JobsModule } from './jobs/jobs.module';
import { ProvidersModule } from './providers/providers.module';
import { QueryModule } from './query/query.module';
import { RateLimitGuard } from './rate-limit/rate-limit.guard';

@Controller('health')
class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  /** Open on purpose: load balancers and the web app call it before they have a key. */
  @Public()
  @Get()
  async health() {
    await this.db.query('SELECT 1');
    const { model, mismatchedDocuments } = await this.documents.embeddingStatus();
    return {
      // "degraded" means some documents were embedded with a different model than the active one.
      status: mismatchedDocuments ? 'degraded' : 'ok',
      authRequired: this.cfg.auth.keys.size > 0,
      embeddingModel: model,
      mismatchedDocuments,
      embeddingProvider: this.cfg.embeddingProvider,
      chatProvider: this.cfg.chatProvider,
      embeddingDim: this.cfg.embeddingDim,
    };
  }
}

@Module({
  imports: [
    {
      module: class ConfigModule {},
      global: true,
      providers: [{ provide: APP_CONFIG, useFactory: loadConfig }],
      exports: [APP_CONFIG],
    },
    DatabaseModule,
    ProvidersModule,
    DocumentsModule,
    JobsModule,
    QueryModule,
  ],
  controllers: [HealthController],
  // Order matters: AuthGuard identifies the user first, then the limiter counts that user.
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
