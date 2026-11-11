import { Migration } from '../migrator';

/**
 * Per-document language for full-text search. `chunks.language` is a regconfig because a generated column may
 * only use immutable functions and to_tsvector(regconfig, text) is one; a text column would need a cast that
 * is not. Existing rows keep the configuration they were indexed with: english.
 */
export const documentLanguage: Migration = {
  id: 2,
  name: 'document_language',
  async up(client) {
    await client.query("ALTER TABLE documents ADD COLUMN language text NOT NULL DEFAULT 'english'");
    await client.query("ALTER TABLE chunks ADD COLUMN language regconfig NOT NULL DEFAULT 'english'");
    await client.query('DROP INDEX chunks_fts_idx');
    await client.query('ALTER TABLE chunks DROP COLUMN fts');
    await client.query(`
      ALTER TABLE chunks ADD COLUMN fts tsvector
        GENERATED ALWAYS AS (to_tsvector(language, coalesce(heading, '') || ' ' || content)) STORED`);
    await client.query('CREATE INDEX chunks_fts_idx ON chunks USING gin (fts)');
  },
};
