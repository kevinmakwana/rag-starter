import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { IS_DEMO_SAFE } from '../src/demo/demo-safe.decorator';
import { DocumentsController } from '../src/documents/documents.controller';
import { JobsController } from '../src/jobs/jobs.controller';
import { QueryController } from '../src/query/query.controller';

type Handler = Record<string, object>;
const handlerOf = (controller: { prototype: object }, name: string) => (controller.prototype as Handler)[name];

/** Every route handler of a controller: the methods carrying a @Get/@Post/... decorator. */
const routes = (controller: { prototype: object }): string[] =>
  Object.getOwnPropertyNames(controller.prototype).filter(
    (name) => name !== 'constructor' && Reflect.getMetadata('method', handlerOf(controller, name)) !== undefined,
  );

const httpMethod = (controller: { prototype: object }, name: string): number =>
  Reflect.getMetadata('method', handlerOf(controller, name));
const demoSafe = (controller: { prototype: object }, name: string): boolean =>
  !!Reflect.getMetadata(IS_DEMO_SAFE, handlerOf(controller, name));

/**
 * Every route has to be classified here. Adding a route without deciding what a demo visitor may do with it
 * fails this test; in demo mode an unclassified write is blocked anyway, so the failure is the reminder.
 */
const CLASSIFIED = [
  { controller: QueryController, reads: [], safeWrites: ['ask', 'stream'], blocked: [] },
  {
    controller: DocumentsController,
    reads: ['list', 'get'],
    safeWrites: [],
    blocked: ['create', 'upload', 'reindexAll', 'update', 'reindex', 'remove'],
  },
  { controller: JobsController, reads: ['list', 'get'], safeWrites: [], blocked: ['indexText', 'upload', 'reindexAll'] },
];

describe.each(CLASSIFIED)('$controller.name in demo mode', ({ controller, reads, safeWrites, blocked }) => {
  it('has every route classified as a read, a safe question, or a blocked write', () => {
    expect(routes(controller).sort()).toEqual([...reads, ...safeWrites, ...blocked].sort());
  });

  it('matches the classification to the real HTTP methods and @DemoSafe() markers', () => {
    for (const name of reads) expect([name, httpMethod(controller, name)]).toEqual([name, RequestMethod.GET]);
    for (const name of safeWrites) {
      expect([name, httpMethod(controller, name), demoSafe(controller, name)]).toEqual([name, RequestMethod.POST, true]);
    }
    for (const name of blocked) {
      expect([name, httpMethod(controller, name) !== RequestMethod.GET, demoSafe(controller, name)]).toEqual([name, true, false]);
    }
  });
});
