import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { seedSamples } from '../src/demo/seed-samples';

/** A DocumentsService stand-in that remembers what was created, keyed by title like the real one lists them. */
function fakeDocuments(options: { duplicateTitles?: string[] } = {}) {
  const stored: { title: string; source: string }[] = [];
  return {
    stored,
    list: async () => stored.map((d) => ({ title: d.title })) as never,
    create: async (dto: { title: string; source?: string }) => {
      stored.push({ title: dto.title, source: dto.source ?? '' });
      return { title: dto.title, duplicate: !!options.duplicateTitles?.includes(dto.title) } as never;
    },
  };
}

describe('seedSamples', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'samples-'));
    await writeFile(join(dir, 'alpha.md'), '# Alpha guide\n\nAlpha text.');
    await writeFile(join(dir, 'beta.txt'), 'Beta plain text without a heading.');
    await writeFile(join(dir, 'logo.png'), 'not a document');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('indexes every .md and .txt file, with the source recorded as samples/<file>, and ignores other files', async () => {
    const documents = fakeDocuments();

    const added = await seedSamples(documents, dir);

    expect(added).toBe(2);
    expect(documents.stored).toEqual([
      { title: 'Alpha guide', source: 'samples/alpha.md' },
      { title: 'beta', source: 'samples/beta.txt' },
    ]);
  });

  it('adds nothing the second time: documents that already exist are skipped', async () => {
    const documents = fakeDocuments();
    await seedSamples(documents, dir);

    expect(await seedSamples(documents, dir)).toBe(0);
    expect(documents.stored).toHaveLength(2);
  });

  it('does not count content the service reports as an existing duplicate', async () => {
    const documents = fakeDocuments({ duplicateTitles: ['Alpha guide'] });

    expect(await seedSamples(documents, dir)).toBe(1);
  });

  it('fails loudly when the directory cannot be read, leaving the caller to decide', async () => {
    await expect(seedSamples(fakeDocuments(), join(dir, 'missing'))).rejects.toThrow(/ENOENT/);
  });
});
