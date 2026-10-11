import { chunkText } from '../src/ingestion/chunker';

const opts = { chunkSize: 200, chunkOverlap: 40 };

describe('chunkText', () => {
  it('returns nothing for empty input', () => {
    expect(chunkText('   \n\n  ', opts)).toEqual([]);
  });

  it('keeps a short document as one chunk', () => {
    const chunks = chunkText('Hello world.\n\nSecond paragraph.', opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ ordinal: 0, heading: null });
    expect(chunks[0].content).toContain('Second paragraph.');
  });

  it('never mixes sections and records the nearest heading', () => {
    const md = '# Intro\n\nAbout the app.\n\n## Setup\n\nRun npm install.\n\n## Usage\n\nAsk a question.';
    const chunks = chunkText(md, opts);
    expect(chunks.map((c) => c.heading)).toEqual(['Intro', 'Setup', 'Usage']);
    expect(chunks[1].content).toBe('Run npm install.');
  });

  it('respects the size limit and numbers chunks in order', () => {
    const paragraph = 'This sentence is filler text for testing. '.repeat(4).trim();
    const chunks = chunkText(Array(8).fill(paragraph).join('\n\n'), opts);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.ordinal).toBe(i);
      expect(c.content.length).toBeLessThanOrEqual(opts.chunkSize);
    });
  });

  it('carries overlap from the previous chunk within a section', () => {
    const a = 'Alpha '.repeat(25).trim();
    const b = 'Bravo '.repeat(25).trim();
    const [first, second] = chunkText(`${a}\n\n${b}`, opts);
    expect(first.content).toBe(a);
    expect(second.content.startsWith('Alpha')).toBe(true);
    expect(second.content).toContain('Bravo');
  });

  it('hard-splits a single oversized paragraph', () => {
    const chunks = chunkText('x'.repeat(650), opts);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    chunks.forEach((c) => expect(c.content.length).toBeLessThanOrEqual(opts.chunkSize));
  });

  it('does not treat # inside code fences as headings', () => {
    const md = '## Shell\n\n```bash\n# install deps\nnpm ci\n```';
    const chunks = chunkText(md, opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe('Shell');
    expect(chunks[0].content).toContain('# install deps');
  });
});
