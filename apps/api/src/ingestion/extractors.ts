import * as mammoth from 'mammoth';
import { extname } from 'path';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';

/** The file could not be turned into text. The message is safe to show to the user. */
export class ExtractionError extends Error {}

/** Turns the bytes of one kind of file into text (Markdown where the format has structure). */
export interface Extractor {
  readonly extensions: readonly string[];
  extract(buffer: Buffer): Promise<string>;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Stop plain paragraph text from being read back as Markdown structure by the chunker. */
const escapeLeading = (text: string) => (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(text) ? `\\${text}` : text);

/**
 * Convert the HTML that mammoth produces (headings, paragraphs, emphasis, links, lists, tables)
 * to Markdown. It is a converter for that well-formed subset, not a general HTML parser; anything
 * it does not know is dropped but its text is kept.
 */
export function htmlToMarkdown(html: string): string {
  const blocks: string[] = [];
  const lists: { ordered: boolean; count: number }[] = [];
  const links: (string | null)[] = [];
  let listLines: string[] = [];
  let pendingItem: string | null = null; // marker of the list item whose text is being collected
  let inline = '';
  let heading = 0;
  let table: string[][] | null = null;
  let row: string[] = [];
  let inCell = false;

  const takeText = () => {
    const text = inline.replace(/\s+/g, ' ').trim();
    inline = '';
    return text;
  };
  const flushItem = () => {
    if (pendingItem === null) return;
    const text = takeText();
    if (text) listLines.push(`${pendingItem}${text}`);
    pendingItem = null;
  };

  for (const token of html.split(/(<[^>]+>)/)) {
    if (!token) continue;
    const tag = token.match(/^<(\/?)([a-z0-9]+)([^>]*)>$/i);
    if (!tag) {
      // Whitespace between table/list tags is layout, not content.
      if (table && !inCell) continue;
      inline += decodeEntities(token);
      continue;
    }
    const closing = tag[1] === '/';
    const name = tag[2].toLowerCase();

    if (/^h[1-6]$/.test(name)) {
      if (closing) {
        const text = takeText();
        if (text) blocks.push(`${'#'.repeat(heading)} ${text}`);
        heading = 0;
      } else {
        heading = Number(name[1]);
      }
    } else if (name === 'p') {
      if (!closing) continue;
      if (table || lists.length) inline += ' ';
      else {
        const text = takeText();
        if (text) blocks.push(escapeLeading(text));
      }
    } else if (name === 'strong' || name === 'b') {
      inline += '**';
    } else if (name === 'em' || name === 'i') {
      inline += '*';
    } else if (name === 'br') {
      inline += ' ';
    } else if (name === 'a') {
      if (closing) {
        const href = links.pop();
        if (href) inline += `](${href})`;
      } else {
        const href = tag[3].match(/href="([^"]*)"/i)?.[1];
        links.push(href ? decodeEntities(href) : null);
        if (href) inline += '[';
      }
    } else if (name === 'ul' || name === 'ol') {
      if (closing) {
        flushItem();
        lists.pop();
        if (!lists.length && listLines.length) {
          blocks.push(listLines.join('\n'));
          listLines = [];
        }
      } else {
        flushItem(); // text of the parent item comes before its nested list
        lists.push({ ordered: name === 'ol', count: 0 });
      }
    } else if (name === 'li') {
      if (closing) flushItem();
      else {
        flushItem();
        const list = lists[lists.length - 1] ?? { ordered: false, count: 0 };
        list.count++;
        pendingItem = `${'  '.repeat(Math.max(lists.length - 1, 0))}${list.ordered ? `${list.count}. ` : '- '}`;
        inline = '';
      }
    } else if (name === 'table') {
      if (closing) {
        if (table?.length) blocks.push(renderTable(table));
        table = null;
      } else {
        table = [];
      }
    } else if (name === 'tr') {
      if (closing) {
        if (table) table.push(row);
      } else {
        row = [];
      }
    } else if (name === 'td' || name === 'th') {
      if (closing) {
        row.push(takeText().replace(/\|/g, '\\|'));
        inCell = false;
      } else {
        inline = '';
        inCell = true;
      }
    }
    // Everything else (img, span, div, sup, ...) is ignored: images carry no text.
  }
  const rest = takeText();
  if (rest) blocks.push(escapeLeading(rest));
  return blocks.join('\n\n');
}

/** The first row becomes the header (Word files rarely mark one), padded to a rectangle. */
function renderTable(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length), 1);
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

const plainText: Extractor = {
  extensions: ['.md', '.markdown', '.txt'],
  extract: async (buffer) => buffer.toString('utf8').replace(/^﻿/, ''),
};

const docx: Extractor = {
  extensions: ['.docx'],
  async extract(buffer) {
    let html: string;
    try {
      // Images carry no text; skipping them also avoids inlining megabytes of base64.
      const result = await mammoth.convertToHtml(
        { buffer },
        { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
      );
      html = result.value;
    } catch (err) {
      throw new ExtractionError(`Could not read the Word document: ${(err as Error).message}`);
    }
    const markdown = htmlToMarkdown(html);
    if (!markdown.trim()) throw new ExtractionError('The Word document has no extractable text.');
    return markdown;
  },
};

const pdf: Extractor = {
  extensions: ['.pdf'],
  async extract(buffer) {
    let text: string;
    try {
      const doc = await getDocumentProxy(Uint8Array.from(buffer));
      try {
        text = (await extractPdfText(doc, { mergePages: true })).text as string;
      } finally {
        await doc.loadingTask.destroy();
      }
    } catch (err) {
      const reason = (err as Error).name === 'PasswordException' ? 'it is password-protected' : (err as Error).message;
      throw new ExtractionError(`Could not read the PDF: ${reason}`);
    }
    if (!text.trim()) {
      throw new ExtractionError(
        'The PDF has no extractable text. It is probably a scan: OCR is not supported, so export a text version.',
      );
    }
    return text;
  },
};

const EXTRACTORS: readonly Extractor[] = [plainText, pdf, docx];

export const SUPPORTED_EXTENSIONS: readonly string[] = EXTRACTORS.flatMap((e) => e.extensions);

/** Extract the text of an uploaded file, choosing the extractor by its extension. */
export async function extractText(filename: string, buffer: Buffer): Promise<string> {
  const ext = extname(filename).toLowerCase();
  const extractor = EXTRACTORS.find((e) => e.extensions.includes(ext));
  if (!extractor) {
    throw new ExtractionError(
      `Unsupported file type "${ext || filename}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`,
    );
  }
  return extractor.extract(buffer);
}
