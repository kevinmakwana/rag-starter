import 'reflect-metadata';
import { DocumentsController } from '../src/documents/documents.controller';
import { JobsController } from '../src/jobs/jobs.controller';
import { QueryController } from '../src/query/query.controller';
import { IS_COSTLY } from '../src/rate-limit/costly.decorator';

const costly = (controller: { prototype: object }, handler: string): boolean =>
  !!Reflect.getMetadata(IS_COSTLY, (controller.prototype as Record<string, object>)[handler]);

describe('which routes are costly', () => {
  it.each([
    [QueryController, 'ask'],
    [QueryController, 'stream'],
    [DocumentsController, 'create'],
    [DocumentsController, 'upload'],
    [DocumentsController, 'reindexAll'],
    [DocumentsController, 'update'],
    [DocumentsController, 'reindex'],
    [JobsController, 'indexText'],
    [JobsController, 'upload'],
    [JobsController, 'reindexAll'],
  ])('%p.%s calls a model and is marked @Costly()', (controller, handler) => {
    expect(costly(controller as never, handler)).toBe(true);
  });

  it.each([
    [DocumentsController, 'list'],
    [DocumentsController, 'get'],
    [DocumentsController, 'remove'],
    [JobsController, 'list'],
    [JobsController, 'get'],
  ])('%p.%s is a cheap route', (controller, handler) => {
    expect(costly(controller as never, handler)).toBe(false);
  });
});
