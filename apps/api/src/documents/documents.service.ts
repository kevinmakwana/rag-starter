import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
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

const toSummary = (r: DocumentRow): DocumentSummary => ({
  id: r.id,
  title: r.title,
  source: r.source,
  charCount: r.char_count,
  chunkCount: r.chunk_count,
  createdAt: r.created_at.toISOString(),
});

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  async create(dto: CreateDocumentDto): Promise<DocumentSummary> {
    const content = dto.content.trim();
    const chunks = chunkText(content, { chunkSize: this.cfg.chunkSize, chunkOverlap: this.cfg.chunkOverlap });
    if (chunks.length === 0) throw new BadRequestException('Document has no text to index');

    // Embed outside the transaction: it is the slow, failure-prone part.
    // The heading is prepended so section titles contribute to retrieval.
    const vectors = await this.embeddings.embed(
      chunks.map((c) => (c.heading ? `${c.heading}\n\n${c.content}` : c.content)),
    );

    const doc = await this.db.transaction(async (client) => {
      const { rows } = await client.query<DocumentRow>(
        `INSERT INTO documents (title, source, char_count, chunk_count)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [dto.title.trim(), dto.source ?? 'paste', content.length, chunks.length],
      );
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

    this.logger.log(`Indexed "${doc.title}" (${chunks.length} chunks via ${this.embeddings.name})`);
    return toSummary(doc);
  }

  async list(): Promise<DocumentSummary[]> {
    const { rows } = await this.db.query<DocumentRow>('SELECT * FROM documents ORDER BY created_at DESC');
    return rows.map(toSummary);
  }

  async remove(id: string): Promise<void> {
    const { rowCount } = await this.db.query('DELETE FROM documents WHERE id = $1', [id]);
    if (!rowCount) throw new NotFoundException(`Document ${id} not found`);
  }
}
