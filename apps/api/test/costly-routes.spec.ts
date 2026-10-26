import 'reflect-metadata';
import { DocumentsController } from '../src/documents/documents.controller';
import { JobsController } from '../src/jobs/jobs.controller';
import { QueryController } from '../src/query/query.controller';
import { IS_COSTLY } from '../src/rate-limit/costly.decorator';

/** Every route handler of a controller: the methods carrying a @Get/@Post/... decorator. */
const routes = (controller: { prototype: object }): string[] =>
  Object.getOwnPropertyNames(controller.prototype).filter(
    (name) => name !== 'constructor' && Reflect.getMetadata('method', (controller.prototype as Record<string, object>)[name]) !== undefined,
  );

const marked = (controller: { prototype: object }, handler: string): boolean =>
  !!Reflect.getMetadata(IS_COSTLY, (controller.prototype as Record<string, object>)[handler]);

/**
 * Every route has to be classified here. Adding a route without deciding whether it calls a model (and so
 * needs @Costly()) fails this test, instead of silently giving it only the general limit.
 */
const CLASSIFIED = [
  { controller: QueryController, costly: ['ask', 'stream'], cheap: [] },
  { controller: DocumentsController, costly: ['create', 'upload', 'reindexAll', 'update', 'reindex'], cheap: ['list', 'get', 'remove'] },
  { controller: JobsController, costly: ['indexText', 'upload', 'reindexAll'], cheap: ['list', 'get'] },
];

describe.each(CLASSIFIED)('$controller.name routes', ({ controller, costly, cheap }) => {
  it('are all classified as costly or cheap, so a new route cannot be forgotten', () => {
    expect(routes(controller).sort()).toEqual([...costly, ...cheap].sort());
  });

  it('marks exactly the costly ones with @Costly()', () => {
    for (const handler of costly) expect([handler, marked(controller, handler)]).toEqual([handler, true]);
    for (const handler of cheap) expect([handler, marked(controller, handler)]).toEqual([handler, false]);
  });
});
