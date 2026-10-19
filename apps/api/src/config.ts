import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

// Load the repo-root .env first, then a local one (local wins only for unset keys).
loadEnv({ path: resolve(process.cwd(), '../../.env') });
loadEnv();

export type EmbeddingProviderName = 'openai' | 'mock';
export type RerankerName = 'none' | 'llm';
export type SearchMode = 'vector' | 'hybrid';
export type ChatProviderName = 'openai' | 'anthropic' | 'mock';

export interface AppConfig {
  databaseUrl: string;
  port: number;
  corsOrigin: string;
  embeddingProvider: EmbeddingProviderName;
  chatProvider: ChatProviderName;
  embeddingDim: number;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  minScore: number;
  /** `hybrid` fuses vector search with Postgres full-text search; `vector` uses embeddings only. */
  searchMode: SearchMode;
  /** Up to this many chunks, vector search is exact instead of using the approximate HNSW index (0 = always HNSW). */
  exactSearchMaxChunks: number;
  /** How many background ingestion jobs run at once. */
  ingestConcurrency: number;
  /** `llm` reorders the retrieved passages with the chat model (one extra call per question). */
  reranker: RerankerName;
  /** How many previous chat messages are used to resolve follow-up questions (0 disables memory). */
  historyMessages: number;
  /** `baseUrl` points the OpenAI client at any OpenAI-compatible server (Ollama, vLLM, LM Studio, ...). */
  openai: { apiKey?: string; baseUrl?: string; embeddingModel: string; chatModel: string };
  anthropic: { apiKey?: string; chatModel: string; maxTokens: number };
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const raw = (process.env[name] ?? fallback) as T;
  if (!allowed.includes(raw)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return raw;
}

export function loadConfig(): AppConfig {
  const cfg: AppConfig = {
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://rag:rag@localhost:5432/rag',
    port: int('API_PORT', 4000),
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:3000',
    embeddingProvider: oneOf('EMBEDDING_PROVIDER', ['openai', 'mock'] as const, 'mock'),
    chatProvider: oneOf('CHAT_PROVIDER', ['openai', 'anthropic', 'mock'] as const, 'mock'),
    embeddingDim: int('EMBEDDING_DIM', 1536),
    chunkSize: int('CHUNK_SIZE', 800),
    chunkOverlap: int('CHUNK_OVERLAP', 120),
    topK: int('TOP_K', 5),
    minScore: 0,
    searchMode: oneOf('SEARCH_MODE', ['vector', 'hybrid'] as const, 'hybrid'),
    exactSearchMaxChunks: int('EXACT_SEARCH_MAX_CHUNKS', 20000),
    ingestConcurrency: int('INGEST_CONCURRENCY', 2),
    reranker: oneOf('RERANKER', ['none', 'llm'] as const, 'none'),
    historyMessages: int('HISTORY_MESSAGES', 6),
    openai: {
      apiKey: process.env.OPENAI_API_KEY || undefined,
      baseUrl: process.env.OPENAI_BASE_URL || undefined,
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      chatModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || undefined,
      chatModel: process.env.ANTHROPIC_CHAT_MODEL ?? 'claude-sonnet-4-5',
      maxTokens: int('ANTHROPIC_MAX_TOKENS', 1024),
    },
  };

  // Hashed keyword vectors score lower than semantic embeddings, so default lower.
  const rawMin = process.env.MIN_SCORE;
  cfg.minScore = rawMin ? Number(rawMin) : cfg.embeddingProvider === 'mock' ? 0.05 : 0.2;

  if (cfg.exactSearchMaxChunks < 0) throw new Error('EXACT_SEARCH_MAX_CHUNKS must be 0 or more');
  if (!Number.isInteger(cfg.ingestConcurrency) || cfg.ingestConcurrency < 1) {
    throw new Error('INGEST_CONCURRENCY must be a whole number of at least 1');
  }
  if (cfg.historyMessages < 0) throw new Error('HISTORY_MESSAGES must be 0 or more');
  if (cfg.chunkOverlap >= cfg.chunkSize) {
    throw new Error('CHUNK_OVERLAP must be smaller than CHUNK_SIZE');
  }
  const needsOpenAI = cfg.embeddingProvider === 'openai' || cfg.chatProvider === 'openai';
  // A self-hosted OpenAI-compatible server usually needs no key.
  if (needsOpenAI && !cfg.openai.apiKey && !cfg.openai.baseUrl) {
    throw new Error('OPENAI_API_KEY is required when an OpenAI provider is selected (or set OPENAI_BASE_URL)');
  }
  if (!Number.isInteger(cfg.anthropic.maxTokens) || cfg.anthropic.maxTokens <= 0) {
    throw new Error('ANTHROPIC_MAX_TOKENS must be a positive whole number');
  }
  if (cfg.chatProvider === 'anthropic' && !cfg.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required when CHAT_PROVIDER=anthropic');
  }
  return cfg;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
