import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { defaultSamplesDir, seedSamples } from './demo/seed-samples';
import { DocumentsService } from './documents/documents.service';

/** Index every .md/.txt file in /samples (see demo/seed-samples.ts). */
async function seed() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  await seedSamples(app.get(DocumentsService), defaultSamplesDir());
  await app.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
