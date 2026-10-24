import 'reflect-metadata';
import { Body, Controller, INestApplication, Module, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'net';
import { configureApp } from '../src/app.setup';
import { APP_CONFIG, AppConfig } from '../src/config';
import { CreateDocumentDto, MAX_DOCUMENT_CHARS } from '../src/documents/documents.dto';

@Controller('documents')
class Probe {
  @Post()
  create(@Body() dto: CreateDocumentDto) {
    return { chars: dto.content.length };
  }
}

describe('JSON body limit', () => {
  const cfg = { corsOrigin: 'http://localhost:3000', trustProxy: false } as unknown as AppConfig;
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  @Module({
    imports: [{ module: class ConfigModule {}, global: true, providers: [{ provide: APP_CONFIG, useValue: cfg }], exports: [APP_CONFIG] }],
    controllers: [Probe],
  })
  class TestModule {}

  const post = async (configure: boolean, content: string) => {
    const nest = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    if (configure) configureApp(nest, cfg);
    await nest.listen(0);
    app = nest;
    const base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
    return fetch(`${base}/documents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Big', content }),
    });
  };

  it('is the reason for the explicit limit: the framework default rejects a document well under the character cap', async () => {
    const res = await post(false, 'a'.repeat(400_000));
    expect(res.status).toBe(413);
  });

  it('accepts a document at the character cap, even when JSON escaping makes the body several times larger', async () => {
    const res = await post(true, '"'.repeat(MAX_DOCUMENT_CHARS));
    expect(res.status).toBe(201);
    expect((await res.json()).chars).toBe(MAX_DOCUMENT_CHARS);
  });

  it('still rejects a body far beyond the cap', async () => {
    const res = await post(true, 'a'.repeat(6_000_000));
    expect(res.status).toBe(413);
  });
});
