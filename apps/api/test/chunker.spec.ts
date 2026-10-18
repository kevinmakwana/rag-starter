import { chunkText, embeddingText } from '../src/ingestion/chunker';

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

describe('heading paths', () => {
  it('records the path of nested sections and drops a lone document title', () => {
    const md = '# Guide\n\n## Setup\n\n### Install\n\nRun npm ci.\n\n### Verify\n\nRun tests.\n\n## Usage\n\nAsk.';
    expect(chunkText(md, opts).map((c) => c.heading)).toEqual(['Setup › Install', 'Setup › Verify', 'Usage']);
  });

  it('keeps the title as the heading of text that sits directly under it', () => {
    expect(chunkText('# Guide\n\nIntro text.\n\n## Setup\n\nGo.', opts).map((c) => c.heading)).toEqual([
      'Guide',
      'Setup',
    ]);
  });

  it('keeps every top-level heading in the path when there are several', () => {
    const md = '# A\n\n## X\n\none\n\n# B\n\n## X\n\ntwo';
    expect(chunkText(md, opts).map((c) => c.heading)).toEqual(['A › X', 'B › X']);
  });

  it('climbs back out of deeper sections', () => {
    expect(chunkText('## A\n\n### B\n\none\n\n## C\n\ntwo', opts).map((c) => c.heading)).toEqual(['A › B', 'C']);
  });

  it('tolerates skipped heading levels', () => {
    expect(chunkText('## A\n\n#### D\n\ntext', opts)[0].heading).toBe('A › D');
  });
});

describe('tables and lists', () => {
  const header = '| Name | Value |\n| --- | --- |';

  it('splits a long table between rows and repeats the header in every part', () => {
    const rows = Array.from({ length: 40 }, (_, i) => `| item${i} | ${i * 7} |`);
    const chunks = chunkText(`${header}\n${rows.join('\n')}`, opts);

    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.content.startsWith(header)).toBe(true);
      expect(c.content.length).toBeLessThanOrEqual(opts.chunkSize);
      c.content.split('\n').forEach((line) => expect(line).toMatch(/^\|.*\|$/)); // never cut mid-row
    }
    const seen = chunks.flatMap((c) => c.content.split('\n').slice(2));
    expect(seen).toEqual(rows); // every row exactly once, in order
  });

  it('splits a long list between items, never between an item and its continuation lines', () => {
    // Varying lengths keep chunk boundaries from landing on item boundaries by coincidence.
    const items = Array.from({ length: 24 }, (_, i) => `- item ${i}: some words about it\n  ${'and more '.repeat((i % 4) + 1)}for ${i}`);
    const chunks = chunkText(items.join('\n'), opts);

    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.content.startsWith('- item')).toBe(true);
      expect(c.content.length).toBeLessThanOrEqual(opts.chunkSize);
    }
    expect(chunks.map((c) => c.content).join('\n')).toBe(items.join('\n')); // lossless, in order, no overlap
  });

  it('keeps a lead-in sentence ending in a colon together with the list it introduces', () => {
    const filler = 'Background sentence about the topic. '.repeat(4).trim(); // ~148 chars
    const md = `${filler}\n\nSteps to deploy:\n\n- build the release artifact\n- ship it to production\n- watch the error rate`;
    // No overlap, so the lead-in can't reach the list by being carried over from the previous chunk.
    const together = chunkText(md, { chunkSize: 200, chunkOverlap: 0 }).filter((c) =>
      c.content.includes('Steps to deploy:'),
    );

    expect(together).toHaveLength(1);
    expect(together[0].content).toContain('- build the release artifact');
  });
});

describe('embeddingText', () => {
  it('prefixes the document title and section so both help retrieval', () => {
    expect(embeddingText('Acme FAQ', { heading: 'Billing', content: 'Invoices are monthly.' })).toBe(
      'Acme FAQ\nBilling\n\nInvoices are monthly.',
    );
  });

  it('does not repeat the title when the heading is the title, or add a blank heading line', () => {
    expect(embeddingText('Acme FAQ', { heading: 'Acme FAQ', content: 'Intro.' })).toBe('Acme FAQ\n\nIntro.');
    expect(embeddingText('Acme FAQ', { heading: null, content: 'Intro.' })).toBe('Acme FAQ\n\nIntro.');
  });
});
