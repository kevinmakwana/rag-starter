import { BadRequestException } from '@nestjs/common';

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
// \p{M}: vowel signs, viramas and combining accents belong to their word (Hindi, Tamil, decomposed "é", "İ" lower-cased).
const ALLOWED = /^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.:/+#-]*$/u;

/**
 * The one place tags are cleaned and checked. Accepts a string, an array, or nothing; commas always separate
 * tags. Returns the distinct tags, lower-cased and sorted, or throws a 400 that does not echo long input.
 */
export function normalizeTags(input: unknown): string[] {
  if (input == null) return [];
  const raw = Array.isArray(input) ? input : [input];
  const tags = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequestException('Tags must be text');
    for (const part of item.split(',')) {
      // Composed form before and after lower-casing, so one tag has one spelling however it was typed.
      const tag = part.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFC');
      if (!tag) continue;
      if (tag.length > MAX_TAG_LENGTH) {
        throw new BadRequestException(`A tag can be at most ${MAX_TAG_LENGTH} characters ("${tag.slice(0, 20)}..." is longer)`);
      }
      if (!ALLOWED.test(tag)) {
        throw new BadRequestException(
          `Tag "${tag}" may only use letters, numbers, spaces and _ - . : / + #, and must start with a letter or number`,
        );
      }
      tags.add(tag);
    }
  }
  if (tags.size > MAX_TAGS) throw new BadRequestException(`At most ${MAX_TAGS} tags per document`);
  return [...tags].sort();
}
