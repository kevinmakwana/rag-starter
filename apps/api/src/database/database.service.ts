import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';

/** Serialize a JS vector into pgvector's text format. */
export const toVector = (v: number[]): string => `[${v.join(',')}]`;

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
  }

  async onModuleInit(): Promise<void> {
    await this.migrate();
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  query<T extends QueryResultRow>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Idempotent schema setup. Kept inline so the starter has zero migration tooling. */
  private async migrate(): Promise<void> {
    const dim = this.cfg.embeddingDim;
    await this.query('CREATE EXTENSION IF NOT EXISTS vector');
    await this.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title       text NOT NULL,
        source      text NOT NULL DEFAULT 'paste',
        char_count  integer NOT NULL,
        chunk_count integer NOT NULL DEFAULT 0,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    // Added after the first release: older databases get the column, their existing rows stay NULL
    // (a unique index allows many NULLs) and are simply never treated as duplicates.
    await this.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash text');
    // The original text, so a document can be re-indexed or edited later. NULL for older documents.
    await this.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS content text');
    // "provider/model/dimensions" of the embeddings; NULL for documents indexed before this was tracked.
    await this.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_model text');
    await this.query('CREATE UNIQUE INDEX IF NOT EXISTS documents_content_hash_idx ON documents(content_hash)');
    await this.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          bigserial PRIMARY KEY,
        document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal     integer NOT NULL,
        heading     text,
        content     text NOT NULL,
        embedding   vector(${dim}) NOT NULL
      )`);
    // Background ingestion queue (see jobs/). Payload and file are dropped once a job finishes.
    await this.query(`
      CREATE TABLE IF NOT EXISTS ingestion_jobs (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind           text NOT NULL,
        status         text NOT NULL DEFAULT 'queued',
        title          text,
        payload        jsonb,
        file           bytea,
        result         jsonb,
        error          text,
        progress_done  integer NOT NULL DEFAULT 0,
        progress_total integer,
        created_at     timestamptz NOT NULL DEFAULT now(),
        started_at     timestamptz,
        finished_at    timestamptz
      )`);
    await this.query(
      "CREATE INDEX IF NOT EXISTS ingestion_jobs_queue_idx ON ingestion_jobs(created_at) WHERE status = 'queued'",
    );
    await this.query('CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id)');
    // Full-text side of hybrid search. Generated, so it stays in sync with heading/content for free.
    await this.query(`
      ALTER TABLE chunks ADD COLUMN IF NOT EXISTS fts tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || content)) STORED`);
    await this.query('CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (fts)');
    // HNSW supports up to 2000 dimensions; above that, fall back to exact search.
    if (dim <= 2000) {
      await this.query(
        'CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)',
      );
    }

    const { rows } = await this.query<{ dim: number }>(
      `SELECT atttypmod AS dim FROM pg_attribute
        WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`,
    );
    if (rows[0]?.dim !== dim) {
      throw new Error(
        `chunks.embedding has ${rows[0]?.dim} dimensions but EMBEDDING_DIM=${dim}. ` +
          'Drop the chunks table (and re-ingest) or set EMBEDDING_DIM to match.',
      );
    }
    this.logger.log(`Schema ready (vector(${dim}))`);
  }
}
