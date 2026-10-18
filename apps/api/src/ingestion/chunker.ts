export interface Chunk {
  ordinal: number;
  /** Section path above the chunk ("Setup › Install"), used for citations and retrieval. */
  heading: string | null;
  content: string;
}

export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
}

type Kind = 'text' | 'table' | 'list';

interface Block {
  heading: string | null;
  text: string;
  kind: Kind;
}

interface Piece {
  text: string;
  kind: Kind;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/;

function kindOf(text: string): Kind {
  const lines = text.split('\n');
  if (lines.length >= 2 && lines.every((l) => TABLE_ROW.test(l))) return 'table';
  if (LIST_ITEM.test(lines[0])) return 'list';
  return 'text';
}

/** Does this Markdown contain exactly one `#` heading? Then it is the document title, not a section. */
function hasSingleTitle(lines: string[]): boolean {
  let titles = 0;
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    if (!inFence && /^#\s+\S/.test(line)) titles++;
  }
  return titles === 1;
}

/** Split Markdown/plain text into paragraph blocks, remembering the heading path of each. */
function toBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const soleTitle = hasSingleTitle(lines);
  const stack: { level: number; text: string }[] = [];
  const blocks: Block[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const path = (): string | null => {
    const parts = stack.map((h) => h.text);
    // Once a section sits below a lone document title, the title only repeats what the source says.
    if (soleTitle && stack.length > 1 && stack[0].level === 1) parts.shift();
    return parts.length ? parts.join(' › ') : null;
  };

  const flush = () => {
    const joined = buffer.join('\n').trim();
    if (joined) blocks.push({ heading: path(), text: joined, kind: kindOf(joined) });
    buffer = [];
  };

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    const match = !inFence ? line.match(HEADING) : null;
    if (match) {
      flush();
      const level = match[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: match[2].trim() });
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return mergeLeadIns(blocks);
}

/** "Steps to deploy:" belongs with the list or table right after it, not in a different chunk. */
function mergeLeadIns(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const block of blocks) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'text' && prev.text.endsWith(':') && prev.heading === block.heading && block.kind !== 'text') {
      out[out.length - 1] = { heading: block.heading, text: `${prev.text}\n${block.text}`, kind: block.kind };
    } else {
      out.push(block);
    }
  }
  return out;
}

/** Hard-split an oversized block on sentence, then word, boundaries. */
function splitSentences(text: string, size: number): string[] {
  if (text.length <= size) return [text];
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*|\n/g) ?? [text];
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if ((current + sentence).length > size && current) {
      parts.push(current.trim());
      current = '';
    }
    if (sentence.length > size) {
      for (let i = 0; i < sentence.length; i += size) parts.push(sentence.slice(i, i + size).trim());
      continue;
    }
    current += sentence;
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

/** Pack whole units (rows, items) into parts of at most `size`, each starting with `header`. */
function packUnits(header: string, units: string[], size: number): string[] {
  const parts: string[] = [];
  let current = header;
  let count = 0;
  for (const unit of units) {
    const next = current ? `${current}\n${unit}` : unit;
    if (next.length > size && count > 0) {
      parts.push(current);
      current = header ? `${header}\n${unit}` : unit;
      count = 1;
    } else {
      current = next;
      count++;
    }
  }
  if (count > 0) parts.push(current);
  return parts;
}

/** Split between rows, repeating the header (and separator) so every part is a valid table. */
function splitTable(text: string, size: number): string[] {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => TABLE_ROW.test(l));
  const lead = lines.slice(0, first).join('\n'); // lead-in sentence, kept with the first part only
  const table = lines.slice(first);
  const headerLines = table.length > 1 && TABLE_SEPARATOR.test(table[1]) ? 2 : 0;
  const header = table.slice(0, headerLines).join('\n');
  const parts = packUnits(header, table.slice(headerLines), size);
  return lead ? [`${lead}\n${parts[0]}`, ...parts.slice(1)] : parts;
}

/** Split between list items; an item's indented continuation lines stay with it. */
function splitList(text: string, size: number): string[] {
  const lines = text.split('\n');
  const lead: string[] = [];
  const items: string[] = [];
  for (const line of lines) {
    if (LIST_ITEM.test(line)) items.push(line);
    else if (items.length) items[items.length - 1] += `\n${line}`;
    else lead.push(line);
  }
  const parts = packUnits('', items, size);
  const leadText = lead.join('\n');
  return leadText ? [`${leadText}\n${parts[0]}`, ...parts.slice(1)] : parts;
}

function splitBlock(block: Block, size: number): Piece[] {
  if (block.text.length <= size) return [{ text: block.text, kind: block.kind }];
  const parts =
    block.kind === 'table'
      ? splitTable(block.text, size)
      : block.kind === 'list'
        ? splitList(block.text, size)
        : splitSentences(block.text, size);
  // A single row/item bigger than a chunk can only be cut by sentence.
  return parts.flatMap((part) =>
    part.length > size ? splitSentences(part, size).map((text) => ({ text, kind: block.kind })) : [{ text: part, kind: block.kind }],
  );
}

/** Last `overlap` characters of a chunk, starting at a word boundary. */
function tail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return overlap > 0 ? text : '';
  const slice = text.slice(text.length - overlap);
  const space = slice.indexOf(' ');
  return space === -1 ? slice : slice.slice(space + 1);
}

/**
 * Structure-aware chunking: packs paragraphs into chunks of roughly `chunkSize`
 * characters, never mixes two sections, and carries `chunkOverlap` characters
 * of context from the previous chunk in the same section. Tables and lists are
 * split between rows/items (tables repeat their header), keep their lead-in
 * sentence, and take no overlap, since a fragment of a row is worse than none.
 */
export function chunkText(text: string, { chunkSize, chunkOverlap }: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  let current = '';
  let currentKind: Kind = 'text';
  let currentHeading: string | null = null;

  const push = () => {
    const content = current.trim();
    if (content) chunks.push({ ordinal: chunks.length, heading: currentHeading, content });
  };

  for (const block of toBlocks(text)) {
    if (block.heading !== currentHeading) {
      push();
      current = '';
      currentHeading = block.heading;
    }
    for (const piece of splitBlock(block, chunkSize)) {
      const candidate = current ? `${current}\n\n${piece.text}` : piece.text;
      if (candidate.length <= chunkSize) {
        current = candidate;
        currentKind = piece.kind;
        continue;
      }
      push();
      // Overlap only helps flowing prose: never prepend half a row or list item.
      const carry = piece.kind === 'text' && currentKind === 'text' ? tail(current, chunkOverlap) : '';
      current = carry && carry.length + piece.text.length + 2 <= chunkSize ? `${carry}\n\n${piece.text}` : piece.text;
      currentKind = piece.kind;
    }
  }
  push();
  return chunks;
}

/**
 * The text that gets embedded for a chunk: document title and section path first, so a passage
 * about "the refund window" still knows it belongs to the "Billing" section of "Acme FAQ".
 */
export function embeddingText(title: string, chunk: { heading: string | null; content: string }): string {
  const header = chunk.heading && chunk.heading !== title ? `${title}\n${chunk.heading}` : title;
  return `${header}\n\n${chunk.content}`;
}
