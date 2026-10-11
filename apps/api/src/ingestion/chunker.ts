export interface Chunk {
  ordinal: number;
  /** Nearest Markdown heading above the chunk, used for citations. */
  heading: string | null;
  content: string;
}

export interface ChunkOptions {
  chunkSize: number;
  chunkOverlap: number;
}

interface Block {
  heading: string | null;
  text: string;
}

const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/** Split Markdown/plain text into paragraph blocks, remembering the current heading. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  let inFence = false;

  const flush = () => {
    const joined = buffer.join('\n').trim();
    if (joined) blocks.push({ heading, text: joined });
    buffer = [];
  };

  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    const match = !inFence ? line.match(HEADING) : null;
    if (match) {
      flush();
      heading = match[1].trim();
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/** Hard-split an oversized block on sentence, then word, boundaries. */
function splitLong(text: string, size: number): string[] {
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
 * of context from the previous chunk in the same section.
 */
export function chunkText(text: string, { chunkSize, chunkOverlap }: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  let current = '';
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
    for (const piece of splitLong(block.text, chunkSize)) {
      const candidate = current ? `${current}\n\n${piece}` : piece;
      if (candidate.length <= chunkSize) {
        current = candidate;
        continue;
      }
      push();
      const carry = tail(current, chunkOverlap);
      current = carry && carry.length + piece.length + 2 <= chunkSize ? `${carry}\n\n${piece}` : piece;
    }
  }
  push();
  return chunks;
}
