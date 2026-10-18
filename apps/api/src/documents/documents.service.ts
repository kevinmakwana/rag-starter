import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { PoolClient } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService, toVector } from '../database/database.service';
import { Chunk, chunkText, embeddingText } from '../ingestion/chunker';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../providers/types';
import { CreateDocumentDto, DocumentDetail, DocumentSummary, UpdateDocumentDto } from './documents.dto';

interface DocumentRow {
  id: string;
  title: string;
  source: string;
  char_count: number;
  chunk_count: number;
  created_at: Date;
  /** Only selected where needed: the full text can be large. NULL for documents indexed before it was stored. */
  content?: string | null;
  content_hash?: string | null;
}

const SUMMARY_COLUMNS = 'id, title, source, char_count, chunk_count, created_at';
const NO_SOURCE_TEXT =
  'This document was indexed before its source text was stored, so there is nothing to re-index from. ' +
  'Upload it again (or send the new text with this request).';

/** Stable fingerprint of a document's text: line endings and outer whitespace don't matter. */
export const hashContent = (content: string): string =>
  createHash('sha256').update(content.replace(/\r\n?/g, '\n').trim()).digest('hex');

export interface ReindexReport {
  reindexed: number;
  /** Not attempted: no stored source text. */
  skipped: { id: string; title: string; reason: string }[];
  /** Attempted and failed (e.g. the embedding provider errored). */
  failed: { id: string; title: string; reason: string }[];
}

const toSummary = (r: DocumentRow, duplicate = false): DocumentSummary => ({
  id: r.id,
  title: r.title,
  source: r.source,
  charCount: r.char_count,
  chunkCount: r.chunk_count,
  createdAt: r.created_at.toISOString(),
  duplicate,
});

@Injectable()
export class DocumentsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  /** Identifies the vector space new embeddings land in: vectors from different ids aren't comparable. */
  private get embeddingId(): string {
    return `${this.embeddings.name}/${this.embeddings.model}/${this.embeddings.dimensions}`;
  }

  /** Documents embedded with a model other than the active one (documents with no recorded model are unknown, not counted). */
  private async otherModels(): Promise<{ model: string; count: number }[]> {
    const { rows } = await this.db.query<{ embedding_model: string; n: number }>(
      `SELECT embedding_model, count(*)::int AS n FROM documents
        WHERE embedding_model IS NOT NULL AND embedding_model <> $1
        GROUP BY embedding_model`,
      [this.embeddingId],
    );
    return rows.map((r) => ({ model: r.embedding_model, count: r.n }));
  }

  async embeddingStatus(): Promise<{ model: string; mismatchedDocuments: number }> {
    const others = await this.otherModels();
    return { model: this.embeddingId, mismatchedDocuments: others.reduce((sum, o) => sum + o.count, 0) };
  }

  async onApplicationBootstrap(): Promise<void> {
    const others = await this.otherModels();
    if (others.length) {
      this.logger.warn(
        `${others.map((o) => `${o.count} document(s) embedded with ${o.model}`).join(', ')}, but the active ` +
          `model is ${this.embeddingId}. Search results will be unreliable until you re-index.`,
      );
    }
  }

  private async findByHash(hash: string): Promise<DocumentRow | undefined> {
    const { rows } = await this.db.query<DocumentRow>(`SELECT ${SUMMARY_COLUMNS} FROM documents WHERE content_hash = $1`, [hash]);
    return rows[0];
  }

  /** Chunk text the way the current settings say; a document with no text is a client error. */
  private chunk(content: string) {
    const chunks = chunkText(content, { chunkSize: this.cfg.chunkSize, chunkOverlap: this.cfg.chunkOverlap });
    if (chunks.length === 0) throw new BadRequestException('Document has no text to index');
    return chunks;
  }

  /** Embed outside any transaction: it is the slow, failure-prone part. Title and section path are included. */
  private embedChunks(title: string, chunks: Chunk[]): Promise<number[][]> {
    return this.embeddings.embed(chunks.map((c) => embeddingText(title, c)));
  }

  /**
   * One statement for every chunk: parallel arrays unnested into rows. (Also sidesteps the
   * 65,535 bind-parameter limit that a multi-row VALUES list would hit on big documents.)
   */
  private async insertChunks(client: PoolClient, documentId: string, chunks: Chunk[], vectors: number[][]) {
    await client.query(
      `INSERT INTO chunks (document_id, ordinal, heading, content, embedding)
       SELECT $1, t.ordinal, t.heading, t.content, t.embedding::vector
         FROM unnest($2::int[], $3::text[], $4::text[], $5::text[]) AS t(ordinal, heading, content, embedding)`,
      [
        documentId,
        chunks.map((c) => c.ordinal),
        chunks.map((c) => c.heading),
        chunks.map((c) => c.content),
        vectors.map(toVector),
      ],
    );
  }

  /** Index a document. Content that is already indexed returns the existing one (`duplicate: true`). */
  async create(dto: CreateDocumentDto): Promise<DocumentSummary> {
    const content = dto.content.trim();
    const chunks = this.chunk(content);

    const hash = hashContent(content);
    const existing = await this.findByHash(hash);
    if (existing) return toSummary(existing, true);

    const others = await this.otherModels();
    if (others.length) {
      throw new ConflictException(
        `This index was built with ${others.map((o) => o.model).join(', ')} but the active embedding model is ` +
          `${this.embeddingId}. Vectors from different models aren't comparable: re-index everything with ` +
          'POST /documents/reindex (or switch the provider back).',
      );
    }

    const title = dto.title.trim();
    const vectors = await this.embedChunks(title, chunks);

    const doc = await this.db.transaction(async (client) => {
      // The unique index on content_hash settles races between concurrent uploads.
      const { rows } = await client.query<DocumentRow>(
        `INSERT INTO documents (title, source, char_count, chunk_count, content_hash, embedding_model, content)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (content_hash) DO NOTHING
         RETURNING ${SUMMARY_COLUMNS}`,
        [title, dto.source ?? 'paste', content.length, chunks.length, hash, this.embeddingId, content],
      );
      if (!rows[0]) return null;
      await this.insertChunks(client, rows[0].id, chunks, vectors);
      return rows[0];
    });

    if (!doc) {
      const winner = await this.findByHash(hash);
      if (winner) return toSummary(winner, true);
      throw new Error('Document insert conflicted but no matching document was found');
    }

    this.logger.log(`Indexed "${doc.title}" (${chunks.length} chunks via ${this.embeddings.name})`);
    return toSummary(doc);
  }

  private async getRow(id: string): Promise<DocumentRow> {
    const { rows } = await this.db.query<DocumentRow>(
      `SELECT ${SUMMARY_COLUMNS}, content, content_hash FROM documents WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException(`Document ${id} not found`);
    return rows[0];
  }

  async get(id: string): Promise<DocumentDetail> {
    const row = await this.getRow(id);
    return { ...toSummary(row), content: row.content ?? null };
  }

  /**
   * Re-chunk and re-embed a document, replacing its chunks atomically so searches see either the
   * old version or the new one. Used for edits and for re-indexing with new settings or a new model.
   */
  private async rebuild(current: DocumentRow, title: string, content: string): Promise<DocumentSummary> {
    const chunks = this.chunk(content);
    const hash = hashContent(content);
    if (hash !== current.content_hash) {
      const other = await this.findByHash(hash);
      if (other && other.id !== current.id) {
        throw new ConflictException(`Identical content is already indexed as "${other.title}" (${other.id}).`);
      }
    }
    const vectors = await this.embedChunks(title, chunks);

    let updated: DocumentRow | undefined;
    try {
      updated = await this.db.transaction(async (client) => {
        const { rows } = await client.query<DocumentRow>(
          `UPDATE documents
              SET title = $2, char_count = $3, chunk_count = $4, content_hash = $5, embedding_model = $6, content = $7
            WHERE id = $1
          RETURNING ${SUMMARY_COLUMNS}`,
          [current.id, title, content.length, chunks.length, hash, this.embeddingId, content],
        );
        if (!rows[0]) return undefined; // deleted while we were embedding
        await client.query('DELETE FROM chunks WHERE document_id = $1', [current.id]);
        await this.insertChunks(client, current.id, chunks, vectors);
        return rows[0];
      });
    } catch (err) {
      // Another document took this content between our check and the write.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictException('Identical content is already indexed as another document.');
      }
      throw err;
    }
    if (!updated) throw new NotFoundException(`Document ${current.id} not found`);

    this.logger.log(`Re-indexed "${updated.title}" (${chunks.length} chunks via ${this.embeddings.name})`);
    return toSummary(updated);
  }

  /** Change a document's title and/or text; either way it is re-embedded, as the title is part of what is embedded. */
  async update(id: string, dto: UpdateDocumentDto): Promise<DocumentSummary> {
    if (dto.title === undefined && dto.content === undefined) {
      throw new BadRequestException('Send a new title, new content, or both');
    }
    const current = await this.getRow(id);
    const content = dto.content !== undefined ? dto.content.trim() : current.content;
    if (content == null) throw new ConflictException(NO_SOURCE_TEXT);
    return this.rebuild(current, dto.title?.trim() ?? current.title, content);
  }

  /** Re-index one document from its stored text with the current chunking settings and embedding model. */
  async reindex(id: string): Promise<DocumentSummary> {
    const current = await this.getRow(id);
    if (current.content == null) throw new ConflictException(NO_SOURCE_TEXT);
    return this.rebuild(current, current.title, current.content);
  }

  /**
   * Re-index every document, e.g. after switching embedding model. One bad document does not stop
   * the rest; documents without stored text are skipped, failures are reported.
   */
  async reindexAll(): Promise<ReindexReport> {
    const { rows } = await this.db.query<{ id: string; title: string; has_content: boolean }>(
      'SELECT id, title, content IS NOT NULL AS has_content FROM documents ORDER BY created_at',
    );
    const report: ReindexReport = { reindexed: 0, skipped: [], failed: [] };
    for (const row of rows) {
      if (!row.has_content) {
        report.skipped.push({ id: row.id, title: row.title, reason: 'Source text was not stored when it was indexed; upload it again.' });
        continue;
      }
      try {
        await this.reindex(row.id);
        report.reindexed++;
      } catch (err) {
        this.logger.warn(`Re-indexing "${row.title}" failed: ${(err as Error).message}`);
        report.failed.push({ id: row.id, title: row.title, reason: (err as Error).message });
      }
    }
    return report;
  }

  async list(): Promise<DocumentSummary[]> {
    const { rows } = await this.db.query<DocumentRow>(
      `SELECT ${SUMMARY_COLUMNS} FROM documents ORDER BY created_at DESC`,
    );
    return rows.map((r) => toSummary(r));
  }

  async remove(id: string): Promise<void> {
    const { rowCount } = await this.db.query('DELETE FROM documents WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundException(`Document ${id} not found`);
  }
}
