import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AppConfig } from '../src/config';
import { DocumentsService, hashContent } from '../src/documents/documents.service';
import { MockEmbeddingProvider } from '../src/providers/mock.provider';

const cfg = { chunkSize: 800, chunkOverlap: 120, ftsLanguage: 'english' } as AppConfig;

const docRow = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Office guide',
  source: 'paste',
  char_count: 30,
  chunk_count: 1,
  created_at: new Date('2026-01-01T00:00:00Z'),
  language: 'english',
  ...overrides,
});

/** Counts embed calls so tests can prove a duplicate never reaches the (paid) provider. */
class CountingEmbeddings extends MockEmbeddingProvider {
  calls = 0;
  override async embed(texts: string[]) {
    this.calls++;
    return super.embed(texts);
  }
}

interface FakeDbOptions {
  /** Row returned when looking a document up by content hash. */
  existing?: ReturnType<typeof docRow> | null;
  /** Row returned by the INSERT inside the transaction (empty = lost a race on the unique hash). */
  inserted?: ReturnType<typeof docRow> | null;
  /** Embedding model ids already stored on other documents (rows differing from the active model). */
  otherModels?: string[];
}

function fakeDb({ existing = null, inserted = docRow(), otherModels = [] }: FakeDbOptions) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO documents/.test(sql)) return { rows: inserted ? [inserted] : [] };
      return { rows: [] };
    },
  };
  return {
    calls,
    textSearchConfigs: new Set(['english', 'german', 'simple']),
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/embedding_model/.test(sql)) return { rows: otherModels.map((m) => ({ embedding_model: m, n: 3 })) };
      return { rows: existing ? [existing] : [] };
    },
    transaction: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
  } as any;
}

describe('hashContent', () => {
  it('ignores line-ending style and surrounding whitespace', () => {
    expect(hashContent('# A\r\n\r\nbody\r\n')).toBe(hashContent('  # A\n\nbody'));
  });

  it('differs when the text differs', () => {
    expect(hashContent('one')).not.toBe(hashContent('two'));
  });
});

describe('DocumentsService.create dedupe', () => {
  it('returns the existing document without embedding when the content was already indexed', async () => {
    const embeddings = new CountingEmbeddings(64);
    const service = new DocumentsService(cfg, embeddings, fakeDb({ existing: docRow({ title: 'First upload' }) }));

    const result = await service.create({ title: 'Renamed copy', content: 'Visitors park in bay C.' });

    expect(result.duplicate).toBe(true);
    expect(result.title).toBe('First upload');
    expect(embeddings.calls).toBe(0);
  });

  it('indexes new content and stores its hash', async () => {
    const embeddings = new CountingEmbeddings(64);
    const db = fakeDb({ existing: null });
    const service = new DocumentsService(cfg, embeddings, db);

    const result = await service.create({ title: 'Office guide', content: 'Visitors park in bay C.' });

    expect(result.duplicate).toBe(false);
    expect(embeddings.calls).toBe(1);
    const insert = db.calls.find((c: { sql: string }) => /INSERT INTO documents/.test(c.sql));
    expect(insert.params).toContain(hashContent('Visitors park in bay C.'));
  });

  it('returns the winner when a concurrent upload of the same content inserts first', async () => {
    const winner = docRow({ title: 'Concurrent winner' });
    const db = fakeDb({ existing: null, inserted: null });
    // First lookup (before embedding) finds nothing; the lookup after the lost race finds the winner.
    let lookups = 0;
    const query = db.query;
    db.query = async (sql: string, params: unknown[]) => {
      if (!/content_hash/.test(sql)) return query(sql, params);
      lookups++;
      return lookups === 1 ? query(sql, params) : { rows: [winner] };
    };
    const service = new DocumentsService(cfg, new CountingEmbeddings(64), db);

    const result = await service.create({ title: 'Mine', content: 'Visitors park in bay C.' });

    expect(result.duplicate).toBe(true);
    expect(result.title).toBe('Concurrent winner');
  });
});

describe('embedding model tracking', () => {
  it('stores the active embedding model id on new documents', async () => {
    const db = fakeDb({ existing: null });
    await new DocumentsService(cfg, new CountingEmbeddings(64), db).create({ title: 'T', content: 'Visitors park in bay C.' });

    const insert = db.calls.find((c: { sql: string }) => /INSERT INTO documents/.test(c.sql));
    expect(insert.sql).toContain('embedding_model');
    expect(insert.params).toContain('mock/hashed-bow/64');
  });

  it('refuses to index when existing documents were embedded with a different model', async () => {
    const embeddings = new CountingEmbeddings(64);
    const db = fakeDb({ existing: null, otherModels: ['openai/text-embedding-3-small/1536'] });
    const service = new DocumentsService(cfg, embeddings, db);

    const attempt = service.create({ title: 'T', content: 'Visitors park in bay C.' });

    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toThrow(/openai\/text-embedding-3-small\/1536.*mock\/hashed-bow\/64/s);
    expect(embeddings.calls).toBe(0);
  });

  it('reports the active model and how many documents were embedded with another one', async () => {
    const db = fakeDb({ otherModels: ['openai/text-embedding-3-small/1536'] });
    const status = await new DocumentsService(cfg, new CountingEmbeddings(64), db).embeddingStatus();

    expect(status).toEqual({ model: 'mock/hashed-bow/64', mismatchedDocuments: 3 });
  });
});

describe('chunk insertion', () => {
  const content = '# Guide\n\n## A\n\nalpha text\n\n## B\n\nbravo text\n\n## C\n\ncharlie text';

  it('writes all chunks of a document in one statement, not one round-trip per chunk', async () => {
    const db = fakeDb({ existing: null });
    await new DocumentsService(cfg, new CountingEmbeddings(64), db).create({ title: 'Guide', content });

    const inserts = db.calls.filter((c: { sql: string }) => /INSERT INTO chunks/.test(c.sql));
    expect(inserts).toHaveLength(1);
  });

  it('passes aligned columns: ordinals, headings, contents and vectors', async () => {
    const db = fakeDb({ existing: null });
    await new DocumentsService(cfg, new CountingEmbeddings(64), db).create({ title: 'Guide', content });

    const [, ordinals, headings, contents, vectors, language] = db.calls.find((c: { sql: string }) =>
      /INSERT INTO chunks/.test(c.sql),
    ).params;
    expect(language).toBe('english');
    expect(ordinals).toEqual([0, 1, 2]);
    expect(headings).toEqual(['A', 'B', 'C']);
    expect(contents).toEqual(['alpha text', 'bravo text', 'charlie text']);
    expect(vectors).toHaveLength(3);
    vectors.forEach((v: string) => expect(v).toMatch(/^\[.*\]$/));
  });

  it('keeps chunks without a heading as NULL', async () => {
    const db = fakeDb({ existing: null });
    await new DocumentsService(cfg, new CountingEmbeddings(64), db).create({ title: 'Plain', content: 'Just text.' });

    const params = db.calls.find((c: { sql: string }) => /INSERT INTO chunks/.test(c.sql)).params;
    expect(params[2]).toEqual([null]);
  });
});

describe('document language', () => {
  const content = '# Guide\n\nDie Rechnungen werden jährlich bezahlt.';
  const service = (db = fakeDb({ existing: null })) => ({ db, svc: new DocumentsService(cfg, new CountingEmbeddings(64), db) });

  it('stores the requested language on the document and its chunks', async () => {
    const { db, svc } = service();
    await svc.create({ title: 'Guide', content, language: 'german' });
    const doc = db.calls.find((c: { sql: string }) => /INSERT INTO documents/.test(c.sql));
    expect(doc.params[doc.params.length - 1]).toBe('german');
    const chunks = db.calls.find((c: { sql: string }) => /INSERT INTO chunks/.test(c.sql));
    expect(chunks.params[5]).toBe('german');
  });

  it('falls back to FTS_LANGUAGE, and normalises what it is given', () => {
    const { svc } = service();
    expect(svc.resolveLanguage(undefined)).toBe('english');
    expect(svc.resolveLanguage('  ')).toBe('english');
    expect(svc.resolveLanguage(' German ')).toBe('german');
  });

  it('rejects a language the database does not have, naming the ones it does, before embedding anything', async () => {
    const embeddings = new CountingEmbeddings(64);
    const svc = new DocumentsService(cfg, embeddings, fakeDb({ existing: null }));
    await expect(svc.create({ title: 'x', content, language: 'klingon' })).rejects.toThrow(BadRequestException);
    await expect(svc.create({ title: 'x', content, language: 'klingon' })).rejects.toThrow(/english, german, simple/);
    expect(embeddings.calls).toBe(0);
  });

  it('rejects a value that is not text', () => {
    expect(() => service().svc.resolveLanguage(['german', 'french'])).toThrow(/text value/);
  });
});
