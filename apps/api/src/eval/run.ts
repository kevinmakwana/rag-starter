import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { readdir, readFile } from 'fs/promises';
import { extname, join, resolve } from 'path';
import { AppModule } from '../app.module';
import { titleFrom } from '../documents/documents.dto';
import { DocumentsService } from '../documents/documents.service';
import { CHAT_PROVIDER, ChatProvider } from '../providers/types';
import { QueryService } from '../query/query.service';
import { answerThresholdsMissed, evaluate, evaluateAnswers, EvalCase, parseRate } from './evaluate';
import { LlmJudge } from './judge';

/**
 * Measure retrieval quality on eval/dataset.json against the configured database and providers.
 *
 *   npm run eval -w apps/api -- [--k=5] [--min-hit=0.8] [--min-mrr=0.6]
 *   npm run eval -w apps/api -- --answers [--min-grounded=0.9] [--min-refusal=0.8]
 *
 * Indexes /samples first (a no-op when already indexed). Exits 1 if a --min-* threshold is missed.
 * `--answers` also generates an answer for every question and has the chat model judge whether each
 * claim is supported by the passages it cites: one extra model call per answer, so it is opt-in.
 */
function arg(name: string, fallback?: number): number | undefined {
  const raw = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  return raw === undefined ? fallback : Number(raw);
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const rate = (name: string) => parseRate(name, process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function main() {
  const answers = flag('answers');
  const minGrounded = rate('min-grounded');
  const minRefusal = rate('min-refusal');
  if (!answers && (minGrounded !== undefined || minRefusal !== undefined)) {
    throw new Error('--min-grounded and --min-refusal need --answers');
  }

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
    for (const f of report.misranked) console.log(`  ~ ${f.question}\n      got: ${f.retrieved.join(' | ')}`);
    for (const f of report.failures) console.log(`  ✗ ${f.question}\n      got: ${f.retrieved.join(' | ') || '(nothing)'}`);

    const minHit = arg('min-hit');
    const minMrr = arg('min-mrr');
    if ((minHit !== undefined && report.hitRate < minHit) || (minMrr !== undefined && report.mrr < minMrr)) {
      process.exitCode = 1;
    }

    if (answers) {
      const chat = app.get<ChatProvider>(CHAT_PROVIDER);
      if (chat.name === 'mock') {
        console.log('\nNote: CHAT_PROVIDER=mock echoes a passage, so groundedness here says nothing about real answers.');
      }
      const answerReport = await evaluateAnswers((question) => query.askWithPassages(question), new LlmJudge(chat), dataset);

      console.log(`\nAnswer eval (answers and judging by ${chat.name})`);
      console.log(`  grounded        ${pct(answerReport.groundedness)}  (mean share of supported claims, ${answerReport.judged} judged)`);
      console.log(`  fully grounded  ${pct(answerReport.fullyGrounded)}`);
      console.log(`  cited           ${pct(answerReport.citationRate)}  (answers that cite a passage)`);
      console.log(`  wrong refusals  ${pct(answerReport.wrongRefusals)}  (refused although the right passage was retrieved)`);
      console.log(`  refusal         ${pct(answerReport.refusalRate)}  (${answerReport.unanswerable} unanswerable questions)`);
      if (answerReport.unjudged) {
        console.log(`  unjudged        ${answerReport.unjudged}  (judge failed; not scored): ${answerReport.unjudgedQuestions.join(' | ')}`);
      }
      for (const f of answerReport.failures) {
        console.log(`  ✗ [${f.reason}] ${f.question}\n      answer: ${f.answer.replace(/\s+/g, ' ').slice(0, 200)}`);
        for (const claim of f.unsupported) console.log(`      unsupported: ${claim}`);
      }

      const missed = answerThresholdsMissed(answerReport, { minGrounded, minRefusal });
      for (const message of missed) console.log(`  ✗ ${message}`);
      if (missed.length) process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
