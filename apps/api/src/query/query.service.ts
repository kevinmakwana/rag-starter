import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { DEFAULT_OWNER } from '../auth/public.decorator';
import { APP_CONFIG, AppConfig } from '../config';
import { DatabaseService, toVector } from '../database/database.service';
import { CHAT_PROVIDER, ChatProvider, EMBEDDING_PROVIDER, EmbeddingProvider } from '../providers/types';
import {
  buildMessages,
  buildRewriteMessages,
  citedIndexes,
  HistoryMessage,
  isRefusal,
  RetrievedChunk,
  sourceLabel,
  trimHistory,
} from './prompt';
import { NoopReranker, RERANKER, Reranker } from './reranker';
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
    /** True when passages were retrieved and the model answered, but cited none of them. */
    citationsMissing?: true;
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
    @Optional() @Inject(RERANKER) private readonly reranker: Reranker = new NoopReranker(),
  ) {}

  /**
   * Is the chunk table small enough to search exactly? Uses Postgres' own row estimate (free, and
   * -1 for a table that has never been analysed, i.e. a small one), so it costs no scan.
   */
  private async useExactSearch(): Promise<boolean> {
    const max = this.cfg.exactSearchMaxChunks ?? 0;
    if (max <= 0) return false;
    const { rows } = await this.db.query<{ estimate: string | number }>(
      "SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = 'chunks'::regclass",
    );
    return !(Number(rows[0]?.estimate) > max);
  }

  /**
   * Nearest chunks by cosine similarity.
   *
   * HNSW is approximate, and entries of deleted chunks linger in the index until VACUUM. We measured
   * an index full of them returning no live rows at all, and (by chance of the random graph) other
   * times a full page of rows that were not the true nearest. A document filter can starve the scan
   * too. So a table up to EXACT_SEARCH_MAX_CHUNKS is searched exactly (`+ 0` stops Postgres using the
   * index for ordering, while a document filter still uses its own btree). Above that the index is
   * used, and if it returns fewer rows than requested the query is re-run exactly.
   */
  private async vectorSearch(
    vector: string,
    limit: number,
    owner: string,
    documentIds?: string[],
  ): Promise<RetrievedChunk[]> {
    const params: unknown[] = [vector, limit, owner];
    let filter = 'WHERE d.owner_id = $3';
    if (documentIds?.length) {
      params.push(documentIds);
      filter += ' AND c.document_id = ANY($4::uuid[])';
    }
    const run = async (orderBy: string): Promise<RetrievedChunk[]> => {
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
          ORDER BY ${orderBy}
          LIMIT $2`,
        params,
      );
      return rows.map((r) => ({ ...r, score: Number(r.score) }));
    };
    const exactOrder = '(c.embedding <=> $1::vector) + 0';

    if (await this.useExactSearch()) return run(exactOrder);
    const approximate = await run('c.embedding <=> $1::vector');
    return approximate.length >= limit ? approximate : run(exactOrder);
  }

  /** Chunks containing any word of the question, best full-text match first. Scores are still cosine. */
  private async lexicalSearch(
    vector: string,
    question: string,
    limit: number,
    owner: string,
    documentIds?: string[],
  ): Promise<RetrievedChunk[]> {
    const tsquery = toOrTsQuery(question);
    if (!tsquery) return [];
    const params: unknown[] = [vector, limit, owner, tsquery];
    let filter = '';
    if (documentIds?.length) {
      params.push(documentIds);
      filter = 'AND c.document_id = ANY($5::uuid[])';
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
        WHERE d.owner_id = $3
          AND c.fts @@ to_tsquery('english', $4)
          ${filter}
        ORDER BY ts_rank_cd(c.fts, to_tsquery('english', $4)) DESC, c.id
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
  async retrieve(
    question: string,
    topK: number,
    documentIds?: string[],
    owner = DEFAULT_OWNER,
  ): Promise<RetrievedChunk[]> {
    const [embedding] = await this.embeddings.embed([question]);
    const vector = toVector(embedding);

    // A reranker needs more candidates than we will finally keep.
    const pool = topK * this.reranker.candidateMultiplier;
    let ranked: RetrievedChunk[];
    if (this.cfg.searchMode === 'hybrid') {
      const fetchLimit = Math.max(pool * 4, 20);
      const [semantic, lexical] = await Promise.all([
        this.vectorSearch(vector, fetchLimit, owner, documentIds),
        this.lexicalSearch(vector, question, fetchLimit, owner, documentIds),
      ]);
      ranked = reciprocalRankFusion([semantic, lexical]).map((f) => f.item);
    } else {
      ranked = await this.vectorSearch(vector, pool, owner, documentIds);
    }
    const candidates = ranked.filter((r) => r.score >= this.cfg.minScore).slice(0, pool);
    return (await this.reranker.rerank(question, candidates)).slice(0, topK);
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
    const sources = this.toSources(chunks, answer);
    const uncited = chunks.length > 0 && !isRefusal(answer) && !sources.some((s) => s.cited);
    return {
      answer,
      sources,
      meta: {
        embeddingProvider: this.embeddings.name,
        chatProvider: this.chat.name,
        retrieved: chunks.length,
        tookMs: Date.now() - started,
        ...(uncited ? { citationsMissing: true as const } : {}),
        ...(rewritten ? { rewrittenQuestion: rewritten } : {}),
      },
    };
  }

  async ask(
    question: string,
    topK = this.cfg.topK,
    documentIds?: string[],
    history?: HistoryMessage[],
    owner = DEFAULT_OWNER,
  ): Promise<QueryResult> {
    const started = Date.now();
    const searchQuestion = await this.standalone(question, history);
    const chunks = await this.retrieve(searchQuestion, topK, documentIds, owner);

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
    owner = DEFAULT_OWNER,
  ): AsyncGenerator<QueryStreamEvent> {
    const started = Date.now();
    const searchQuestion = await this.standalone(question, history);
    const chunks = await this.retrieve(searchQuestion, topK, documentIds, owner);
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
