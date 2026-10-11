import { config as loadEnv } from 'dotenv';
import { resolve } from 'path';

// Load the repo-root .env first, then a local one (local wins only for unset keys).
loadEnv({ path: resolve(__dirname, '../../../.env') });
loadEnv();

export type EmbeddingProviderName = 'openai' | 'mock';
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
  openai: { apiKey?: string; embeddingModel: string; chatModel: string };
  anthropic: { apiKey?: string; chatModel: string };
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
    openai: {
      apiKey: process.env.OPENAI_API_KEY || undefined,
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-small',
      chatModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-4o-mini',
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || undefined,
      chatModel: process.env.ANTHROPIC_CHAT_MODEL ?? 'claude-sonnet-4-5',
    },
  };

  // Hashed keyword vectors score lower than semantic embeddings, so default lower.
  const rawMin = process.env.MIN_SCORE;
  cfg.minScore = rawMin ? Number(rawMin) : cfg.embeddingProvider === 'mock' ? 0.05 : 0.2;

  if (cfg.chunkOverlap >= cfg.chunkSize) {
    throw new Error('CHUNK_OVERLAP must be smaller than CHUNK_SIZE');
  }
  const needsOpenAI = cfg.embeddingProvider === 'openai' || cfg.chatProvider === 'openai';
  if (needsOpenAI && !cfg.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is required when an OpenAI provider is selected');
  }
  if (cfg.chatProvider === 'anthropic' && !cfg.anthropic.apiKey) {
    throw new Error('ANTHROPIC_API_KEY is required when CHAT_PROVIDER=anthropic');
  }
  return cfg;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
