import { Controller, Get, Inject, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { DocumentsModule } from './documents/documents.module';
import { ProvidersModule } from './providers/providers.module';
import { QueryModule } from './query/query.module';

@Controller('health')
class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  @Get()
  async health() {
    await this.db.query('SELECT 1');
    return {
      status: 'ok',
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
    QueryModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
