import 'reflect-metadata';
import { AppConfig } from '../src/config';
import { DemoSeeder } from '../src/demo/demo-seeder';

const config = (enabled: boolean) => ({ demo: { enabled, maxQueriesPerDay: 500 } }) as unknown as AppConfig;

describe('DemoSeeder', () => {
  const documentsThatRecord = () => {
    const created: string[] = [];
    return {
      created,
      list: async () => [] as never,
      create: async (dto: { title: string }) => (created.push(dto.title), { title: dto.title, duplicate: false }) as never,
    };
  };

  it('does nothing when demo mode is off', async () => {
    const documents = documentsThatRecord();

    await new DemoSeeder(config(false), documents as never).onApplicationBootstrap();

    expect(documents.created).toEqual([]);
  });

  it('indexes the real samples directory in demo mode', async () => {
    const documents = documentsThatRecord();

    await new DemoSeeder(config(true), documents as never).onApplicationBootstrap();

    expect(documents.created.length).toBeGreaterThanOrEqual(2);
  });

  it('stops waiting for a seeding that hangs, so the API still opens its port', async () => {
    const hanging = { list: () => new Promise(() => undefined), create: async () => undefined as never };
    const seeder = new DemoSeeder(config(true), hanging as never);
    seeder.waitMs = 20;

    await expect(seeder.onApplicationBootstrap()).resolves.toBeUndefined();
  }, 2000);

  it('logs and carries on when seeding fails, so the API still starts', async () => {
    const failing = {
      list: async () => {
        throw new Error('embedding provider unreachable');
      },
      create: async () => undefined as never,
    };

    await expect(new DemoSeeder(config(true), failing as never).onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
