import { BadRequestException } from '@nestjs/common';

/** What a question may be narrowed to. Every field is optional and they combine with AND. */
export interface DocumentFilter {
  /** Only these documents. */
  documentIds?: string[];
  /** Documents with any of these tags (already normalised). */
  tags?: string[];
  /** Exact match on the document's `source`. */
  source?: string;
  /** ISO instants: indexed at or after / strictly before. */
  createdAfter?: string;
  createdBefore?: string;
}

/**
 * The SQL for a filter, as ` AND ...` conditions on the `documents` table under `alias`, numbering its
 * parameters from `$firstParam`. Empty when there is nothing to filter on.
 */
export function documentFilterSql(
  filter: DocumentFilter | undefined,
  alias: string,
  firstParam: number,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (condition: (n: number) => string, value: unknown) => {
    params.push(value);
    parts.push(` AND ${condition(firstParam + params.length - 1)}`);
  };
  if (filter?.documentIds?.length) add((n) => `${alias}.id = ANY($${n}::uuid[])`, filter.documentIds);
  if (filter?.tags?.length) add((n) => `${alias}.tags && $${n}::text[]`, filter.tags);
  if (filter?.source) add((n) => `${alias}.source = $${n}`, filter.source);
  if (filter?.createdAfter) add((n) => `${alias}.created_at >= $${n}::timestamptz`, filter.createdAfter);
  if (filter?.createdBefore) add((n) => `${alias}.created_at < $${n}::timestamptz`, filter.createdBefore);
  return { sql: parts.join(''), params };
}

/** An ISO 8601 date or date-time as an instant, so the database's time zone never matters. */
export function toInstant(name: string, value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new BadRequestException(`${name} must be an ISO 8601 date or date-time`);
  const instant = new Date(ms);
  // Postgres has no year 0 (or earlier, as JavaScript counts it) and would fail the query with a 500.
  if (instant.getUTCFullYear() < 1) throw new BadRequestException(`${name} must be in the year 1 or later`);
  return instant.toISOString();
}
