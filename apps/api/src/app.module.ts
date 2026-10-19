import { Controller, Get, Inject, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { DocumentsModule } from './documents/documents.module';
import { DocumentsService } from './documents/documents.service';
import { JobsModule } from './jobs/jobs.module';
import { ProvidersModule } from './providers/providers.module';
import { QueryModule } from './query/query.module';

@Controller('health')
class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  @Get()
  async health() {
    await this.db.query('SELECT 1');
    const { model, mismatchedDocuments } = await this.documents.embeddingStatus();
    return {
      // "degraded" means some documents were embedded with a different model than the active one.
      status: mismatchedDocuments ? 'degraded' : 'ok',
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
})
export class AppModule {}
