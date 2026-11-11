import { Migration } from '../migrator';

/**
 * The schema as it stood when versioned migrations began. Every statement is idempotent, so a database that
 * was built by the old run-on-every-start setup (any release) adopts it unchanged and an empty one is built
 * from it. Do not edit it once released; add a new migration instead.
 */
export const baseline: Migration = {
  id: 1,
  name: 'baseline',
  async up(client, { embeddingDim: dim }) {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query(`
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
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS content_hash text');
    // The original text, so a document can be re-indexed or edited later. NULL for older documents.
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS content text');
    // "provider/model/dimensions" of the embeddings; NULL for documents indexed before this was tracked.
    await client.query('ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_model text');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS documents_content_hash_idx ON documents(content_hash)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS chunks (
        id          bigserial PRIMARY KEY,
        document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal     integer NOT NULL,
        heading     text,
        content     text NOT NULL,
        embedding   vector(${dim}) NOT NULL
      )`);
    // Who a document belongs to. Documents from before accounts existed (and everything when
    // authentication is off) belong to 'default'. Identical text from two users must stay two
    // documents, so the content hash is unique per owner, not globally.
    await client.query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'default'");
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS documents_owner_hash_idx ON documents(owner_id, content_hash)');
    await client.query('DROP INDEX IF EXISTS documents_content_hash_idx');
    // Background ingestion queue (see jobs/). Payload and file are dropped once a job finishes.
    await client.query(`
      CREATE TABLE IF NOT EXISTS ingestion_jobs (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        kind           text NOT NULL,
        status         text NOT NULL DEFAULT 'queued',
        title          text,
        payload        jsonb,
        file           bytea,
        owner_id       text NOT NULL DEFAULT 'default',
        result         jsonb,
        error          text,
        progress_done  integer NOT NULL DEFAULT 0,
        progress_total integer,
        created_at     timestamptz NOT NULL DEFAULT now(),
        started_at     timestamptz,
        finished_at    timestamptz
      )`);
    await client.query("ALTER TABLE ingestion_jobs ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT 'default'");
    await client.query(
      "CREATE INDEX IF NOT EXISTS ingestion_jobs_queue_idx ON ingestion_jobs(created_at) WHERE status = 'queued'",
    );
    await client.query('CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id)');
    // Full-text side of hybrid search. Generated, so it stays in sync with heading/content for free.
    await client.query(`
      ALTER TABLE chunks ADD COLUMN IF NOT EXISTS fts tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(heading, '') || ' ' || content)) STORED`);
    await client.query('CREATE INDEX IF NOT EXISTS chunks_fts_idx ON chunks USING gin (fts)');
    // HNSW supports up to 2000 dimensions; above that, fall back to exact search.
    if (dim <= 2000) {
      await client.query(
        'CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)',
      );
    }
  },
};
