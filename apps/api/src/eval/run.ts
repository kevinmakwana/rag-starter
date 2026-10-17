import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { readdir, readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { AppModule } from '../app.module';
import { titleFrom } from '../documents/documents.dto';
import { DocumentsService } from '../documents/documents.service';
import { QueryService } from '../query/query.service';
import { evaluate, EvalCase } from './evaluate';

/**
 * Measure retrieval quality on eval/dataset.json against the configured database and providers.
 *
 *   npm run eval -w apps/api -- [--k=5] [--min-hit=0.8] [--min-mrr=0.6]
 *
 * Indexes /samples first (a no-op when already indexed). Exits 1 if a --min-* threshold is missed.
 */
function arg(name: string, fallback?: number): number | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  return raw === undefined ? fallback : Number(raw);
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function main() {
  const k = arg('k', 5)!;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const documents = app.get(DocumentsService);
    const query = app.get(QueryService);

    const dir = resolve(process.cwd(), '../../samples');
    for (const file of (await readdir(dir)).filter((f) => ['.md', '.txt'].includes(extname(f)))) {
      const content = await readFile(join(dir, file), 'utf8');
      await documents.create({ title: titleFrom(content, file), content, source: `samples/${file}` });
    }

    const dataset: EvalCase[] = JSON.parse(await readFile(resolve(process.cwd(), 'eval/dataset.json'), 'utf8'));
    const report = await evaluate((question, limit) => query.retrieve(question, limit), dataset, k);

    console.log(`Retrieval eval (k=${k}, ${(await documents.embeddingStatus()).model})`);
    console.log(`  hit@${k}   ${pct(report.hitRate)}  (${report.answerable} answerable questions)`);
    console.log(`  hit@1    ${pct(report.top1Rate)}`);
    console.log(`  MRR      ${report.mrr.toFixed(3)}`);
    console.log(`  abstain  ${pct(report.abstainRate)}  (${report.unanswerable} unanswerable questions)`);
    for (const f of report.failures) console.log(`  ✗ ${f.question}\n      got: ${f.retrieved.join(' | ') || '(nothing)'}`);

    const minHit = arg('min-hit');
    const minMrr = arg('min-mrr');
    if ((minHit !== undefined && report.hitRate < minHit) || (minMrr !== undefined && report.mrr < minMrr)) {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
