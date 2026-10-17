import { Global, Module } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { APP_CONFIG, AppConfig } from '../config';
import { AnthropicChatProvider } from './anthropic.provider';
import { MockChatProvider, MockEmbeddingProvider } from './mock.provider';
import { OpenAIChatProvider, OpenAIEmbeddingProvider } from './openai.provider';
import { LlmReranker, NoopReranker, RERANKER, Reranker } from '../query/reranker';
import { CHAT_PROVIDER, ChatProvider, EMBEDDING_PROVIDER, EmbeddingProvider } from './types';

export function createEmbeddingProvider(cfg: AppConfig): EmbeddingProvider {
  switch (cfg.embeddingProvider) {
    case 'openai':
      return new OpenAIEmbeddingProvider(
        new OpenAI({ apiKey: cfg.openai.apiKey }),
        cfg.openai.embeddingModel,
        cfg.embeddingDim,
      );
    case 'mock':
      return new MockEmbeddingProvider(cfg.embeddingDim);
  }
}

export function createChatProvider(cfg: AppConfig): ChatProvider {
  switch (cfg.chatProvider) {
    case 'openai':
      return new OpenAIChatProvider(new OpenAI({ apiKey: cfg.openai.apiKey }), cfg.openai.chatModel);
    case 'anthropic':
      return new AnthropicChatProvider(
        new Anthropic({ apiKey: cfg.anthropic.apiKey }),
        cfg.anthropic.chatModel,
      );
    case 'mock':
      return new MockChatProvider();
  }
}

export function createReranker(cfg: AppConfig, chat: ChatProvider): Reranker {
  return cfg.reranker === 'llm' ? new LlmReranker(chat) : new NoopReranker();
}

@Global()
@Module({
  providers: [
    { provide: EMBEDDING_PROVIDER, inject: [APP_CONFIG], useFactory: createEmbeddingProvider },
    { provide: CHAT_PROVIDER, inject: [APP_CONFIG], useFactory: createChatProvider },
    { provide: RERANKER, inject: [APP_CONFIG, CHAT_PROVIDER], useFactory: createReranker },
  ],
  exports: [EMBEDDING_PROVIDER, CHAT_PROVIDER, RERANKER],
})
export class ProvidersModule {}
