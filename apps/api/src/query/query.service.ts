import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService, toVector } from '../database/database.service';
import { CHAT_PROVIDER, ChatProvider, EMBEDDING_PROVIDER, EmbeddingProvider } from '../providers/types';
import { buildMessages, citedIndexes, RetrievedChunk, sourceLabel } from './prompt';

export interface Source {
  n: number;
  documentId: string;
  title: string;
  heading: string | null;
  label: string;
  snippet: string;
  score: number;
  cited: boolean;
}

export interface QueryResult {
  answer: string;
  sources: Source[];
  meta: { embeddingProvider: string; chatProvider: string; retrieved: number; tookMs: number };
}

const NO_CONTEXT_ANSWER = "I don't know based on the provided documents.";

@Injectable()
export class QueryService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(CHAT_PROVIDER) private readonly chat: ChatProvider,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  async retrieve(question: string, topK: number, documentIds?: string[]): Promise<RetrievedChunk[]> {
    const [vector] = await this.embeddings.embed([question]);
    const filter = documentIds?.length ? 'WHERE c.document_id = ANY($3::uuid[])' : '';
    const params: unknown[] = [toVector(vector), topK];
    if (filter) params.push(documentIds);

    const { rows } = await this.db.query<RetrievedChunk>(
      `SELECT c.id::text            AS "chunkId",
              c.document_id         AS "documentId",
              d.title,
              c.heading,
              c.content,
              1 - (c.embedding <=> $1::vector) AS score
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
         ${filter}
        ORDER BY c.embedding <=> $1::vector
        LIMIT $2`,
      params,
    );
    return rows
      .map((r) => ({ ...r, score: Number(r.score) }))
      .filter((r) => r.score >= this.cfg.minScore);
  }

  async ask(question: string, topK = this.cfg.topK, documentIds?: string[]): Promise<QueryResult> {
    const started = Date.now();
    const chunks = await this.retrieve(question, topK, documentIds);

    const answer = chunks.length
      ? await this.chat.complete(buildMessages(question, chunks))
      : NO_CONTEXT_ANSWER;

    const cited = new Set(citedIndexes(answer, chunks.length));
    return {
      answer,
      sources: chunks.map((c, i) => ({
        n: i + 1,
        documentId: c.documentId,
        title: c.title,
        heading: c.heading,
        label: sourceLabel(c),
        snippet: c.content.length > 320 ? `${c.content.slice(0, 320)}…` : c.content,
        score: Math.round(c.score * 1000) / 1000,
        cited: cited.has(i + 1),
      })),
      meta: {
        embeddingProvider: this.embeddings.name,
        chatProvider: this.chat.name,
        retrieved: chunks.length,
        tookMs: Date.now() - started,
      },
    };
  }
}
