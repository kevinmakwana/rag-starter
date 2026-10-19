import { HttpException, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { DEFAULT_OWNER } from '../auth/public.decorator';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService } from '../database/database.service';
import { DocumentsService } from '../documents/documents.service';

export type JobKind = 'ingest_text' | 'ingest_file' | 'reindex_all';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

interface JobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  title: string | null;
  payload: Record<string, unknown> | null;
  file: Buffer | null;
  owner_id: string;
  result: unknown | null;
  error: string | null;
  progress_done: number;
  progress_total: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/** What the API shows about a job. Never includes the payload or the uploaded bytes. */
export interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  title: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress?: { done: number; total: number };
  result?: unknown;
  error?: string;
}

const VIEW_COLUMNS =
  'id, kind, status, title, result, error, progress_done, progress_total, created_at, started_at, finished_at';
const RETENTION = '7 days';
const POLL_MS = 5_000;
const PURGE_MS = 60 * 60 * 1000;

const toView = (r: JobRow): JobView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  title: r.title,
  createdAt: r.created_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null,
  ...(r.progress_total != null ? { progress: { done: r.progress_done, total: r.progress_total } } : {}),
  ...(r.result != null ? { result: r.result } : {}),
  ...(r.error != null ? { error: r.error } : {}),
});

/** The message a user should see for a failure, including Nest's validation/conflict responses. */
function messageOf(err: unknown): string {
  if (err instanceof HttpException) {
    const response = err.getResponse();
    const message = typeof response === 'string' ? response : (response as { message?: string | string[] }).message;
    return Array.isArray(message) ? message.join(', ') : (message ?? err.message);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * A small durable job queue on Postgres, run inside the API process. Jobs are claimed with
 * FOR UPDATE SKIP LOCKED, so claiming is safe even with several API instances; recovering
 * jobs interrupted by a restart assumes a single instance (see README).
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private readonly running = new Set<Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private draining = false;
  private drainAgain = false;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverInterrupted();
    await this.purgeOld();
    // Safety nets: pick up queued jobs that nothing woke us for, and keep the table small.
    this.timers = [setInterval(() => this.kick(), POLL_MS), setInterval(() => void this.purgeOld(), PURGE_MS)];
    this.timers.forEach((t) => t.unref());
    this.kick();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    await Promise.allSettled([...this.running]);
  }

  async enqueue(
    kind: JobKind,
    { title, payload, file, owner = DEFAULT_OWNER }: { title: string; payload?: Record<string, unknown>; file?: Buffer; owner?: string },
  ): Promise<JobView> {
    const { rows } = await this.db.query<JobRow>(
      `INSERT INTO ingestion_jobs (kind, title, payload, file, owner_id) VALUES ($1, $2, $3, $4, $5)
       RETURNING ${VIEW_COLUMNS}`,
      [kind, title, payload ?? null, file ?? null, owner],
    );
    this.kick();
    return toView(rows[0]);
  }

  /** Another user's job is reported as missing, not forbidden. */
  async get(id: string, owner = DEFAULT_OWNER): Promise<JobView | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `SELECT ${VIEW_COLUMNS} FROM ingestion_jobs WHERE id = $1 AND owner_id = $2`,
      [id, owner],
    );
    return rows[0] && toView(rows[0]);
  }

  async list(owner = DEFAULT_OWNER, limit = 50): Promise<JobView[]> {
    const { rows } = await this.db.query<JobRow>(
      `SELECT ${VIEW_COLUMNS} FROM ingestion_jobs WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [owner, limit],
    );
    return rows.map(toView);
  }

  /** Jobs still marked running when we start were cut off by a restart; re-running could loop on a bad file. */
  async recoverInterrupted(): Promise<void> {
    const { rowCount } = await this.db.query(
      `UPDATE ingestion_jobs
          SET status = 'failed', error = 'Interrupted by a server restart; submit it again.',
              payload = NULL, file = NULL, finished_at = now()
        WHERE status = 'running'`,
    );
    if (rowCount) this.logger.warn(`Marked ${rowCount} interrupted job(s) as failed`);
  }

  async purgeOld(): Promise<void> {
    await this.db.query(`DELETE FROM ingestion_jobs WHERE finished_at < now() - interval '${RETENTION}'`);
  }

  /** Start as many queued jobs as there are free slots. Re-entrant calls are folded into one more pass. */
  private kick(): void {
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainAgain = false;
        while (!this.stopped && this.running.size < this.cfg.ingestConcurrency) {
          const job = await this.claim();
          if (!job) break;
          const done: Promise<void> = this.execute(job).finally(() => {
            this.running.delete(done);
            this.kick();
          });
          this.running.add(done);
        }
      } while (this.drainAgain && !this.stopped);
    } catch (err) {
      this.logger.error(`Job queue error: ${(err as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  private async claim(): Promise<JobRow | undefined> {
    const { rows } = await this.db.query<JobRow>(
      `UPDATE ingestion_jobs SET status = 'running', started_at = now()
        WHERE id = (SELECT id FROM ingestion_jobs WHERE status = 'queued'
                     ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`,
    );
    return rows[0];
  }

  private async execute(job: JobRow): Promise<void> {
    try {
      const result = await this.dispatch(job);
      await this.db.query(
        `UPDATE ingestion_jobs SET status = 'succeeded', result = $2, payload = NULL, file = NULL, finished_at = now()
          WHERE id = $1`,
        [job.id, JSON.stringify(result)],
      );
    } catch (err) {
      const message = messageOf(err);
      this.logger.warn(`Job ${job.id} (${job.kind}) failed: ${message}`);
      await this.db
        .query(
          `UPDATE ingestion_jobs SET status = 'failed', error = $2, payload = NULL, file = NULL, finished_at = now()
            WHERE id = $1`,
          [job.id, message],
        )
        .catch((e) => this.logger.error(`Could not record failure of job ${job.id}: ${e.message}`));
    }
  }

  private async dispatch(job: JobRow): Promise<unknown> {
    switch (job.kind) {
      case 'ingest_text':
        return this.documents.create(job.payload as never, job.owner_id);
      case 'ingest_file':
        return this.documents.ingestFile(String(job.payload?.filename), job.file ?? Buffer.alloc(0), job.owner_id);
      case 'reindex_all':
        return this.documents.reindexAll(job.owner_id, (done, total) =>
          this.db
            .query('UPDATE ingestion_jobs SET progress_done = $2, progress_total = $3 WHERE id = $1', [job.id, done, total])
            .then(() => undefined),
        );
    }
  }
}
