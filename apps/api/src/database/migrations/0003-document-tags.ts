import { Migration } from '../migrator';

/** Free-form labels on a document, for filtering questions. Existing documents have none. */
export const documentTags: Migration = {
  id: 3,
  name: 'document_tags',
  async up(client) {
    await client.query("ALTER TABLE documents ADD COLUMN tags text[] NOT NULL DEFAULT '{}'");
    await client.query('CREATE INDEX documents_tags_idx ON documents USING gin (tags)');
  },
};
