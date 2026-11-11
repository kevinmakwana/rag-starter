import { BadRequestException } from '@nestjs/common';
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from '../src/documents/tags';

describe('normalizeTags', () => {
  it('trims, lower-cases, collapses spaces, removes duplicates and sorts', () => {
    expect(normalizeTags(['  Billing ', 'PRICING', 'billing', 'Team   Plans'])).toEqual(['billing', 'pricing', 'team plans']);
  });

  it('splits on commas, in a single string and in every element', () => {
    expect(normalizeTags('b, a,,c')).toEqual(['a', 'b', 'c']);
    expect(normalizeTags(['b,a', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('treats nothing as no tags', () => {
    expect(normalizeTags(undefined)).toEqual([]);
    expect(normalizeTags(null)).toEqual([]);
    expect(normalizeTags('')).toEqual([]);
    expect(normalizeTags([' ', ','])).toEqual([]);
  });

  it('accepts accents, other scripts and the punctuation people use in labels', () => {
    expect(normalizeTags(['Café', 'документ', 'c++', 'v1.2', 'team:billing', 'a/b', 'q-a', 'issue#42'])).toEqual([
      'a/b', 'c++', 'café', 'issue#42', 'q-a', 'team:billing', 'v1.2', 'документ',
    ]);
  });

  it('keeps combining marks, so words in Indic scripts and decomposed accents are valid tags', () => {
    expect(normalizeTags(['हिन्दी'])).toEqual(['हिन्दी']);
    expect(normalizeTags(['தமிழ்'])).toEqual(['தமிழ்']);
    expect(normalizeTags(['İstanbul'])).toHaveLength(1); // lower-casing İ gives i plus a combining dot
  });

  it('composes accents, so one tag has one spelling whichever way it was typed', () => {
    expect(normalizeTags(['cafe\u0301'])).toEqual(['caf\u00e9']);
    expect(normalizeTags(['cafe\u0301', 'caf\u00e9'])).toEqual(['caf\u00e9']);
  });

  it('rejects a tag that is too long, naming the limit, without echoing all of it', () => {
    const long = 'x'.repeat(MAX_TAG_LENGTH + 1);
    expect(() => normalizeTags([long])).toThrow(BadRequestException);
    expect(() => normalizeTags([long])).toThrow(new RegExp(String(MAX_TAG_LENGTH)));
    try {
      normalizeTags(['y'.repeat(5000)]);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      expect(JSON.stringify((err as BadRequestException).getResponse()).length).toBeLessThan(300);
    }
  });

  it('rejects more than the maximum number of distinct tags, but not repeats of one', () => {
    const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
    expect(() => normalizeTags(many)).toThrow(new RegExp(String(MAX_TAGS)));
    expect(normalizeTags([...many.slice(0, MAX_TAGS), 't0', 'T0'])).toHaveLength(MAX_TAGS);
  });

  it('rejects characters outside the allowed set, and anything that is not text', () => {
    expect(() => normalizeTags(['<script>'])).toThrow(BadRequestException);
    expect(() => normalizeTags(['a;b'])).toThrow(BadRequestException);
    expect(() => normalizeTags(["it's"])).toThrow(BadRequestException);
    expect(() => normalizeTags(['_leading'])).toThrow(BadRequestException);
    expect(() => normalizeTags(['#leading'])).toThrow(BadRequestException); // a tag starts with a letter or number
    expect(() => normalizeTags(['\u0301leading'])).toThrow(BadRequestException); // ... not a combining mark
    expect(() => normalizeTags([1 as unknown as string])).toThrow(/text/);
    expect(() => normalizeTags({ a: 1 })).toThrow(/text/);
  });
});
