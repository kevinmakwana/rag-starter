import { Logger } from '@nestjs/common';
import { readdir, readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { titleFrom } from '../documents/documents.dto';
import type { DocumentsService } from '../documents/documents.service';

/** The repo's /samples folder, as seen from apps/api (where npm runs the scripts and the API). */
export const defaultSamplesDir = (): string => resolve(process.cwd(), '../../samples');

/**
 * Index every .md/.txt file in `dir` for the default user. Skips titles that already exist and content that is
 * already indexed (documents indexed before content hashes were stored have no hash to compare). Returns how
 * many documents were added.
 */
export async function seedSamples(documents: Pick<DocumentsService, 'list' | 'create'>, dir: string): Promise<number> {
  const existing = new Set((await documents.list()).map((d) => d.title));
  const files = (await readdir(dir)).filter((f) => ['.md', '.txt'].includes(extname(f))).sort();

  let added = 0;
  for (const file of files) {
    const content = await readFile(join(dir, file), 'utf8');
    const title = titleFrom(content, file.slice(0, -extname(file).length));
    if (existing.has(title)) {
      Logger.log(`Skipping "${title}" (already indexed)`, 'Seed');
      continue;
    }
    const doc = await documents.create({ title, content, source: `samples/${file}` });
    if (doc.duplicate) Logger.log(`Skipping "${title}" (identical content already indexed)`, 'Seed');
    else added++;
  }
  return added;
}
