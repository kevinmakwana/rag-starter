import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService, toVector } from '../database/database.service';
import { CHAT_PROVIDER, ChatProvider, EMBEDDING_PROVIDER, EmbeddingProvider } from '../providers/types';
import {
  buildMessages,
  buildRewriteMessages,
  citedIndexes,
  HistoryMessage,
  RetrievedChunk,
  sourceLabel,
  trimHistory,
} from './prompt';
import { reciprocalRankFusion, toOrTsQuery } from './search';

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
  meta: {
    embeddingProvider: string;
    chatProvider: string;
    retrieved: number;
    tookMs: number;
    /** The standalone question retrieval used, present only when a follow-up was rewritten. */
    rewrittenQuestion?: string;
  };
}

export type QueryStreamEvent =
  | { type: 'sources'; sources: Source[] }
  | { type: 'token'; text: string }
  | { type: 'done'; result: QueryResult };

const NO_CONTEXT_ANSWER = "I don't know based on the provided documents.";

@Injectable()
export class QueryService {
  private readonly logger = new Logger(QueryService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
    @Inject(CHAT_PROVIDER) private readonly chat: ChatProvider,
    @Inject(DatabaseService) private readonly db: DatabaseService,
  ) {}

  /** Nearest chunks by cosine similarity. */
  private async vectorSearch(vector: string, limit: number, documentIds?: string[]): Promise<RetrievedChunk[]> {
    const params: unknown[] = [vector, limit];
    let filter = '';
    if (documentIds?.length) {
      params.push(documentIds);
      filter = 'WHERE c.document_id = ANY($3::uuid[])';
    }
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
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }

  /** Chunks containing any word of the question, best full-text match first. Scores are still cosine. */
  private async lexicalSearch(
    vector: string,
    question: string,
    limit: number,
    documentIds?: string[],
  ): Promise<RetrievedChunk[]> {
    const tsquery = toOrTsQuery(question);
    if (!tsquery) return [];
    const params: unknown[] = [vector, limit, tsquery];
    let filter = '';
    if (documentIds?.length) {
      params.push(documentIds);
      filter = 'AND c.document_id = ANY($4::uuid[])';
    }
    const { rows } = await this.db.query<RetrievedChunk>(
      `SELECT c.id::text            AS "chunkId",
              c.document_id         AS "documentId",
              d.title,
              c.heading,
              c.content,
              1 - (c.embedding <=> $1::vector) AS score
         FROM chunks c
         JOIN documents d ON d.id = c.document_id
        WHERE c.fts @@ to_tsquery('english', $3)
          ${filter}
        ORDER BY ts_rank_cd(c.fts, to_tsquery('english', $3)) DESC
        LIMIT $2`,
      params,
    );
    return rows.map((r) => ({ ...r, score: Number(r.score) }));
  }

  /**
   * Top `topK` chunks for a question. In hybrid mode the vector and full-text candidate lists are
   * merged with reciprocal rank fusion, which rescues exact terms (names, codes, numbers) that
   * embeddings blur. Either way chunks below MIN_SCORE (cosine) are dropped afterwards, so
   * a question the documents can't answer still retrieves nothing.
   */
  async retrieve(question: string, topK: number, documentIds?: string[]): Promise<RetrievedChunk[]> {
    const [embedding] = await this.embeddings.embed([question]);
    const vector = toVector(embedding);

    let ranked: RetrievedChunk[];
    if (this.cfg.searchMode === 'hybrid') {
      const candidates = Math.max(topK * 4, 20);
      const [semantic, lexical] = await Promise.all([
        this.vectorSearch(vector, candidates, documentIds),
        this.lexicalSearch(vector, question, candidates, documentIds),
      ]);
      ranked = reciprocalRankFusion([semantic, lexical]).map((f) => f.item);
    } else {
      ranked = await this.vectorSearch(vector, topK, documentIds);
    }
    return ranked.filter((r) => r.score >= this.cfg.minScore).slice(0, topK);
  }

  private toSources(chunks: RetrievedChunk[], answer = ''): Source[] {
    const cited = new Set(citedIndexes(answer, chunks.length));
    return chunks.map((c, i) => ({
      n: i + 1,
      documentId: c.documentId,
      title: c.title,
      heading: c.heading,
      label: sourceLabel(c),
      snippet: c.content.length > 320 ? `${c.content.slice(0, 320)}…` : c.content,
      score: Math.round(c.score * 1000) / 1000,
      cited: cited.has(i + 1),
    }));
  }

  /**
   * Turn a follow-up ("and for annual plans?") into a standalone question using recent history.
   * With no history there is nothing to resolve and no model call is made; if the rewrite
   * fails we search with the question as asked rather than failing the whole request.
   */
  private async standalone(question: string, history?: HistoryMessage[]): Promise<string> {
    const recent = trimHistory(history, { maxMessages: this.cfg.historyMessages, maxChars: 1000 });
    if (!recent.length) return question;
    try {
      const raw = await this.chat.complete(buildRewriteMessages(question, recent));
      const rewritten = raw.split('\n')[0].trim().replace(/^["']|["']$/g, '').slice(0, 500);
      return rewritten || question;
    } catch (err) {
      this.logger.warn(`Question rewrite failed, using the original: ${(err as Error).message}`);
      return question;
    }
  }

  private toResult(answer: string, chunks: RetrievedChunk[], started: number, rewritten?: string): QueryResult {
    return {
      answer,
      sources: this.toSources(chunks, answer),
      meta: {
        embeddingProvider: this.embeddings.name,
        chatProvider: this.chat.name,
        retrieved: chunks.length,
        tookMs: Date.now() - started,
        ...(rewritten ? { rewrittenQuestion: rewritten } : {}),
      },
    };
  }

  async ask(
    question: string,
    topK = this.cfg.topK,
    documentIds?: string[],
    history?: HistoryMessage[],
  ): Promise<QueryResult> {
    const started = Date.now();
    const searchQuestion = await this.standalone(question, history);
    const chunks = await this.retrieve(searchQuestion, topK, documentIds);

    const answer = chunks.length
      ? await this.chat.complete(buildMessages(searchQuestion, chunks))
      : NO_CONTEXT_ANSWER;

    return this.toResult(answer, chunks, started, searchQuestion !== question ? searchQuestion : undefined);
  }

  /**
   * Same pipeline as `ask`, but yields the sources as soon as retrieval finishes,
   * then the answer token by token, then the final result (with `cited` resolved).
   */
  async *askStream(
    question: string,
    topK = this.cfg.topK,
    documentIds?: string[],
    signal?: AbortSignal,
    history?: HistoryMessage[],
  ): AsyncGenerator<QueryStreamEvent> {
    const started = Date.now();
    const searchQuestion = await this.standalone(question, history);
    const chunks = await this.retrieve(searchQuestion, topK, documentIds);
    yield { type: 'sources', sources: this.toSources(chunks) };

    let answer = '';
    if (chunks.length) {
      for await (const text of this.chat.stream(buildMessages(searchQuestion, chunks), signal)) {
        answer += text;
        yield { type: 'token', text };
      }
    } else {
      answer = NO_CONTEXT_ANSWER;
      yield { type: 'token', text: answer };
    }
    yield {
      type: 'done',
      result: this.toResult(answer.trim(), chunks, started, searchQuestion !== question ? searchQuestion : undefined),
    };
  }
}
