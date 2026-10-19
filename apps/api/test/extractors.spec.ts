import 'reflect-metadata';
import { extractText, ExtractionError, htmlToMarkdown, SUPPORTED_EXTENSIONS } from '../src/ingestion/extractors';
import { chunkText } from '../src/ingestion/chunker';
import { boldPara, bullet, makeDocx, makePdf, para, table } from './helpers/office';

describe('htmlToMarkdown', () => {
  it('converts headings and paragraphs', () => {
    expect(htmlToMarkdown('<h1>Title</h1><p>Some text.</p><h2>Part</h2><p>More.</p>')).toBe(
      '# Title\n\nSome text.\n\n## Part\n\nMore.',
    );
  });

  it('keeps inline emphasis and links, decodes entities', () => {
    expect(htmlToMarkdown('<p>A <strong>bold</strong> and <em>soft</em> &amp; <a href="https://x.test/a">link</a> &lt;ok&gt;</p>')).toBe(
      'A **bold** and *soft* & [link](https://x.test/a) <ok>',
    );
  });

  it('converts bulleted and numbered lists, with nesting', () => {
    const html = '<ul><li>One</li><li>Two<ul><li>Two-a</li></ul></li></ul><ol><li>First</li><li>Second</li></ol>';
    expect(htmlToMarkdown(html)).toBe('- One\n- Two\n  - Two-a\n\n1. First\n2. Second');
  });

  it('converts a table with its first row as the header', () => {
    const html = '<table><tr><td>Name</td><td>Days</td></tr><tr><td>Annual</td><td>25</td></tr></table>';
    expect(htmlToMarkdown(html)).toBe('| Name | Days |\n| --- | --- |\n| Annual | 25 |');
  });

  it('keeps pipes and line breaks inside cells from breaking the table', () => {
    const html = '<table><tr><td>a|b</td><td>x<br />y</td></tr></table>';
    expect(htmlToMarkdown(html)).toBe('| a\\|b | x y |\n| --- | --- |');
  });

  it('pads ragged rows so every row has the same number of cells', () => {
    const html = '<table><tr><td>A</td><td>B</td></tr><tr><td>1</td></tr></table>';
    expect(htmlToMarkdown(html)).toBe('| A | B |\n| --- | --- |\n| 1 |  |');
  });

  it('drops images, including embedded data URIs', () => {
    expect(htmlToMarkdown('<p>Before<img src="data:image/png;base64,AAAA" />After</p>')).toBe('BeforeAfter');
  });

  it('does not let paragraph text masquerade as Markdown structure', () => {
    expect(htmlToMarkdown('<p># not a heading</p><p>- not a list</p>')).toBe('\\# not a heading\n\n\\- not a list');
  });
});

describe('extractText', () => {
  it('reads Markdown and plain text as UTF-8 and strips a byte-order mark', async () => {
    const bom = Buffer.from('﻿# Café\n\nBody', 'utf8');
    expect(await extractText('notes.md', bom)).toBe('# Café\n\nBody');
    expect(await extractText('NOTES.TXT', Buffer.from('plain'))).toBe('plain');
  });

  it('lists what it supports', () => {
    expect([...SUPPORTED_EXTENSIONS].sort()).toEqual(['.docx', '.markdown', '.md', '.pdf', '.txt']);
  });

  it('rejects unsupported file types with a clear message', async () => {
    await expect(extractText('data.xlsx', Buffer.from('x'))).rejects.toThrow(/\.docx.*\.pdf|supported/i);
    await expect(extractText('data.xlsx', Buffer.from('x'))).rejects.toBeInstanceOf(ExtractionError);
  });

  describe('.docx', () => {
    it('keeps headings, lists and tables as Markdown', async () => {
      const docx = await makeDocx(
        [
          para('Employee Handbook', 'Heading1'),
          para('Welcome to the team.'),
          para('Leave policy', 'Heading2'),
          boldPara('Important:'),
          bullet('Annual leave: 25 days'),
          bullet('Sick leave: 10 days'),
          table([
            ['Type', 'Days'],
            ['Annual', '25'],
          ]),
        ].join(''),
      );

      const md = await extractText('handbook.docx', docx);

      expect(md).toContain('# Employee Handbook');
      expect(md).toContain('## Leave policy');
      expect(md).toContain('**Important:**');
      expect(md).toContain('- Annual leave: 25 days\n- Sick leave: 10 days');
      expect(md).toContain('| Type | Days |\n| --- | --- |\n| Annual | 25 |');
    });

    it('produces text the chunker can section by heading', async () => {
      const docx = await makeDocx(
        [para('Guide', 'Heading1'), para('Setup', 'Heading2'), para('Run it.'), para('Usage', 'Heading2'), para('Ask.')].join(''),
      );
      const chunks = chunkText(await extractText('guide.docx', docx), { chunkSize: 500, chunkOverlap: 50 });
      expect(chunks.map((c) => c.heading)).toEqual(['Setup', 'Usage']);
    });

    it('reports a file that is not a real .docx', async () => {
      await expect(extractText('fake.docx', Buffer.from('not a zip'))).rejects.toBeInstanceOf(ExtractionError);
    });

    it('reports a document with no text', async () => {
      const empty = await makeDocx('');
      await expect(extractText('empty.docx', empty)).rejects.toThrow(/no (extractable )?text/i);
    });
  });

  describe('.pdf', () => {
    it('extracts the text of every page', async () => {
      const pdf = makePdf([['Refund policy', 'Annual plans can be refunded within 30 days.'], ['Support hours', 'Monday to Friday.']]);

      const text = await extractText('faq.pdf', pdf);

      expect(text).toContain('Refund policy');
      expect(text).toContain('Annual plans can be refunded within 30 days.');
      expect(text).toContain('Support hours');
      expect(text.indexOf('Refund')).toBeLessThan(text.indexOf('Support hours'));
    });

    it('reports a file that is not a real PDF', async () => {
      await expect(extractText('fake.pdf', Buffer.from('not a pdf'))).rejects.toBeInstanceOf(ExtractionError);
    });

    it('explains that scanned PDFs without a text layer are not supported', async () => {
      await expect(extractText('scan.pdf', makePdf([[]]))).rejects.toThrow(/scanned|OCR/i);
    });
  });
});
