import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { DocumentsService } from '../documents/documents.service';
import { defaultSamplesDir, seedSamples } from './seed-samples';

/**
 * In demo mode, makes sure the sample documents are indexed before the API starts answering, so a fresh deploy
 * works with no manual `npm run seed`. A restart re-embeds nothing. A failure (say the embedding provider is
 * unreachable) is logged, not fatal: an empty demo that says so beats one that does not start. If it takes longer
 * than `waitMs` the API starts anyway and seeding finishes in the background.
 */
@Injectable()
export class DemoSeeder implements OnApplicationBootstrap {
  private readonly logger = new Logger(DemoSeeder.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  /** How long startup waits for seeding. A provider that hangs must not keep the API from opening its port. */
  waitMs = 30_000;

  async onApplicationBootstrap(): Promise<void> {
    if (!this.cfg.demo.enabled) return;
    const seeding = seedSamples(this.documents, defaultSamplesDir()).then(
      (added) => this.logger.log(`Sample documents ready (${added} added)`),
      (err) => this.logger.error(`Could not index the sample documents: ${(err as Error).message}`),
    );
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.waitMs);
    });
    const late = await Promise.race([seeding.then(() => false), timedOut]);
    clearTimeout(timer);
    if (late) this.logger.warn(`Still indexing the sample documents after ${this.waitMs / 1000}s; starting anyway.`);
  }
}
