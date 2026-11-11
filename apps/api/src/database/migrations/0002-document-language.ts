import { Migration } from '../migrator';

/**
 * Per-document language for full-text search. A generated column may only use immutable functions, and
 * to_tsvector(text, text) is not one (the text-to-regconfig cast is stable), hence the wrapper below. It is
 * immutable in practice because the names of the built-in configurations never change meaning. The language is
 * kept as plain text rather than a regconfig column: pg_upgrade refuses databases with regconfig columns.
 * Existing rows keep the configuration they were indexed with: english.
 *
 * Note for operators: regenerating a stored column rewrites `chunks` and rebuilds all its indexes, vector index
 * included, under a lock. On a large corpus the first start after this migration takes a while (see the guide).
 */
export const documentLanguage: Migration = {
  id: 2,
  name: 'document_language',
  async up(client) {
    await client.query(`
      CREATE FUNCTION chunk_tsvector(config text, heading text, body text) RETURNS tsvector
        LANGUAGE sql IMMUTABLE PARALLEL SAFE
        AS $$ SELECT to_tsvector(config::regconfig, coalesce(heading, '') || ' ' || body) $$`);
    await client.query("ALTER TABLE documents ADD COLUMN language text NOT NULL DEFAULT 'english'");
    await client.query("ALTER TABLE chunks ADD COLUMN language text NOT NULL DEFAULT 'english'");
    await client.query('DROP INDEX chunks_fts_idx');
    await client.query('ALTER TABLE chunks DROP COLUMN fts');
    await client.query(
      'ALTER TABLE chunks ADD COLUMN fts tsvector GENERATED ALWAYS AS (chunk_tsvector(language, heading, content)) STORED',
    );
    await client.query('CREATE INDEX chunks_fts_idx ON chunks USING gin (fts)');
  },
};
