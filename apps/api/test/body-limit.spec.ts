import 'reflect-metadata';
import { Body, Controller, INestApplication, Module, Post, Put } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AddressInfo } from 'net';
import { configureApp } from '../src/app.setup';
import { APP_CONFIG, AppConfig } from '../src/config';
import { CreateDocumentDto, MAX_DOCUMENT_CHARS } from '../src/documents/documents.dto';

@Controller('documents')
class DocumentsProbe {
  @Post()
  create(@Body() dto: CreateDocumentDto) {
    return { chars: dto.content.length };
  }

  @Put(':id')
  update(@Body() dto: CreateDocumentDto) {
    return { chars: dto.content.length };
  }
}

@Controller('jobs')
class JobsProbe {
  @Post('documents')
  create(@Body() dto: CreateDocumentDto) {
    return { chars: dto.content.length };
  }
}

/** Stands in for /query: a small JSON body that has to stay small. */
@Controller('query')
class QueryProbe {
  @Post()
  ask(@Body() body: Record<string, unknown>) {
    return { keys: Object.keys(body).length };
  }
}

describe('JSON body limits', () => {
  const cfg = { corsOrigin: 'http://localhost:3000', trustProxy: false } as unknown as AppConfig;
  let app: INestApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  @Module({
    imports: [{ module: class ConfigModule {}, global: true, providers: [{ provide: APP_CONFIG, useValue: cfg }], exports: [APP_CONFIG] }],
    controllers: [DocumentsProbe, JobsProbe, QueryProbe],
  })
  class TestModule {}

  const send = async (configure: boolean, method: 'POST' | 'PUT', path: string, body: unknown) => {
    const nest = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    if (configure) configureApp(nest, cfg);
    await nest.listen(0);
    app = nest;
    const base = `http://127.0.0.1:${(nest.getHttpServer().address() as AddressInfo).port}`;
    return fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  };
  const document = (content: string) => ({ title: 'Big', content });

  it('is the reason for the explicit limit: the framework default rejects a document well under the character cap', async () => {
    const res = await send(false, 'POST', '/documents', document('a'.repeat(400_000)));
    expect(res.status).toBe(413);
  });

  it.each([
    ['POST', '/documents'],
    ['PUT', '/documents/6f1c1f0e-9a53-4a53-8a39-2f6a4bd3a111'],
    ['POST', '/jobs/documents'],
  ] as const)('accepts a document at the character cap on %s %s, even when JSON escaping makes the body several times larger', async (method, path) => {
    const res = await send(true, method, path, document('"'.repeat(MAX_DOCUMENT_CHARS)));
    expect(res.status).toBe(method === 'POST' ? 201 : 200);
    expect(((await res.json()) as { chars: number }).chars).toBe(MAX_DOCUMENT_CHARS);
  });

  it('still rejects a document body far beyond the cap', async () => {
    const res = await send(true, 'POST', '/documents', document('a'.repeat(6_000_000)));
    expect(res.status).toBe(413);
  });

  it('keeps routes that never need big bodies small: a 600 kB question is refused', async () => {
    const res = await send(true, 'POST', '/query', { question: 'a'.repeat(600_000) });
    expect(res.status).toBe(413);
  });

  it('still takes the largest valid question: 2,000 characters plus 20 history messages of 4,000, all escaped', async () => {
    const history = Array.from({ length: 20 }, () => ({ role: 'user', content: '\u0001'.repeat(4000) }));
    const res = await send(true, 'POST', '/query', { question: '\u0001'.repeat(2000), history });
    expect(res.status).toBe(201);
  });
});
