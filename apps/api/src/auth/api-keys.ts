import { createHash } from 'crypto';

export interface ApiKey {
  key: string;
  user: string;
}

export const MIN_KEY_LENGTH = 16;
const USER = /^[A-Za-z0-9._@-]{1,64}$/;

/** Keys are only ever compared by hash, so lookups don't depend on how much of a guess is right. */
export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex');

/**
 * Parse `API_KEYS="key1:alice,key2:bob"`. Empty means authentication is off. Error messages name the
 * position of the bad entry, never its content, so a mistyped secret doesn't end up in logs.
 */
export function parseApiKeys(raw: string | undefined): ApiKey[] {
  const entries = (raw ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const where = `API_KEYS entry #${index + 1}`;
    const split = entry.lastIndexOf(':');
    const key = split > 0 ? entry.slice(0, split).trim() : '';
    const user = split > 0 ? entry.slice(split + 1).trim() : '';
    if (!key || !user) throw new Error(`${where} must look like key:user`);
    if (key.length < MIN_KEY_LENGTH) throw new Error(`${where}: keys must be at least ${MIN_KEY_LENGTH} characters`);
    if (!USER.test(user)) throw new Error(`${where}: user names may only use letters, digits and . _ @ - (max 64)`);
    if (seen.has(key)) throw new Error(`${where} repeats an earlier key`);
    seen.add(key);
    return { key, user };
  });
}
