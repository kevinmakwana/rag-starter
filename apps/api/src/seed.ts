import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readdir, readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { AppModule } from './app.module';
import { titleFrom } from './documents/documents.dto';
import { DocumentsService } from './documents/documents.service';

/** Index every .md/.txt file in /samples (skips titles that already exist). */
async function seed() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  const documents = app.get(DocumentsService);
  const dir = resolve(__dirname, '../../../samples');

  const existing = new Set((await documents.list()).map((d) => d.title));
  const files = (await readdir(dir)).filter((f) => ['.md', '.txt'].includes(extname(f)));

  for (const file of files) {
    const content = await readFile(join(dir, file), 'utf8');
    const title = titleFrom(content, file.slice(0, -extname(file).length));
    if (existing.has(title)) {
      Logger.log(`Skipping "${title}" (already indexed)`, 'Seed');
      continue;
    }
    await documents.create({ title, content, source: `samples/${file}` });
  }
  await app.close();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
