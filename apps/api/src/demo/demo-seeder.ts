import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { DocumentsService } from '../documents/documents.service';
import { defaultSamplesDir, seedSamples } from './seed-samples';

/**
 * In demo mode, makes sure the sample documents are indexed before the API starts answering, so a fresh deploy
 * works with no manual `npm run seed`. A restart re-embeds nothing. A failure (say the embedding provider is
 * unreachable) is logged, not fatal: an empty demo that says so beats one that does not start.
 */
@Injectable()
export class DemoSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoSeeder.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.demo.enabled) return;
    try {
      const added = await seedSamples(this.documents, defaultSamplesDir());
      this.logger.log(`Sample documents ready (${added} added)`);
    } catch (err) {
      this.logger.error(`Could not index the sample documents: ${(err as Error).message}`);
    }
  }
}
