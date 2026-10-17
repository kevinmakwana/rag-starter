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
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService, toVector } from '../database/database.service';
import { chunkText } from '../ingestion/chunker';
import { EMBEDDING_PROVIDER, EmbeddingProvider } from '../providers/types';
import { CreateDocumentDto, DocumentSummary } from './documents.dto';

interface DocumentRow {
  id: string;
  title: string;
  source: string;
  char_count: number;
  chunk_count: number;
  created_at: Date;
}

/** Stable fingerprint of a document's text: line endings and outer whitespace don't matter. */
export const hashContent = (content: string): string =>
  createHash('sha256').update(content.replace(/\r\n?/g, '\n').trim()).digest('hex');

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
    const { rows } = await this.db.query<DocumentRow>('SELECT * FROM documents WHERE content_hash = $1', [hash]);
    return rows[0];
  }

  /** Index a document. Content that is already indexed returns the existing one (`duplicate: true`). */
  async create(dto: CreateDocumentDto): Promise<DocumentSummary> {
    const content = dto.content.trim();
    const chunks = chunkText(content, { chunkSize: this.cfg.chunkSize, chunkOverlap: this.cfg.chunkOverlap });
    if (chunks.length === 0) throw new BadRequestException('Document has no text to index');

    const hash = hashContent(content);
    const existing = await this.findByHash(hash);
    if (existing) return toSummary(existing, true);

    const others = await this.otherModels();
    if (others.length) {
      throw new ConflictException(
        `This index was built with ${others.map((o) => o.model).join(', ')} but the active embedding model is ` +
          `${this.embeddingId}. Vectors from different models aren't comparable: re-index everything with one ` +
          'model (see the README) or switch the provider back.',
      );
    }

    // Embed outside the transaction: it is the slow, failure-prone part.
    // The heading is prepended so section titles contribute to retrieval.
    const vectors = await this.embeddings.embed(
      chunks.map((c) => (c.heading ? `${c.heading}\n\n${c.content}` : c.content)),
    );

    const doc = await this.db.transaction(async (client) => {
      // The unique index on content_hash settles races between concurrent uploads.
      const { rows } = await client.query<DocumentRow>(
        `INSERT INTO documents (title, source, char_count, chunk_count, content_hash, embedding_model)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (content_hash) DO NOTHING
         RETURNING *`,
        [dto.title.trim(), dto.source ?? 'paste', content.length, chunks.length, hash, this.embeddingId],
      );
      if (!rows[0]) return null;
      const documentId = rows[0].id;
      for (const [i, chunk] of chunks.entries()) {
        await client.query(
          `INSERT INTO chunks (document_id, ordinal, heading, content, embedding)
           VALUES ($1, $2, $3, $4, $5::vector)`,
          [documentId, chunk.ordinal, chunk.heading, chunk.content, toVector(vectors[i])],
        );
      }
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

  async list(): Promise<DocumentSummary[]> {
    const { rows } = await this.db.query<DocumentRow>('SELECT * FROM documents ORDER BY created_at DESC');
    return rows.map((r) => toSummary(r));
  }

  async remove(id: string): Promise<void> {
    const { rowCount } = await this.db.query('DELETE FROM documents WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundException(`Document ${id} not found`);
  }
}
