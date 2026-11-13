/**
 * Shared keyset cursor for every `/api/v0` list (API.md §5: `cursor` + `limit`,
 * default 20, maximum 100, `next_cursor` while more rows exist).
 *
 * A cursor is the sort key of a page's last row, `|`-joined and base64url-encoded, so it
 * stays opaque to clients. Timestamps travel as microsecond-exact UTC text read from
 * Postgres: a JS `Date` keeps only milliseconds and would skip rows at a page boundary.
 */

import { z } from 'zod';

/** API.md §5 page bounds. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** The `cursor` and `limit` query parameters every list route accepts. */
export const pageQuery = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

/** What a list function takes; no cursor means the first page. */
export interface PageRequest {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export class InvalidCursorError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super('The pagination cursor is not valid.');
    this.name = 'InvalidCursorError';
  }
}

/** Clamps a requested page size into 1..MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE when absent. */
export function pageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
}

/** SQL selecting a `timestamptz` as microsecond UTC text, whatever the session time zone. */
export function timestampText(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Up to six fraction digits, so a millisecond cursor issued before this module still decodes.
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** A real UTC instant Postgres can cast to `timestamptz` (a bad date is a 400, not a 500). */
export function isUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const fields = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const [year, month, day, hour, minute, second] = fields;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls 2026-02-30 over to March; a round trip catches it.
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

export function encodeCursor(parts: readonly string[]): string {
  return Buffer.from(parts.join('|'), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor with one validator per part; any mismatch throws `InvalidCursorError`,
 * so a crafted cursor never reaches the SQL casts.
 */
export function decodeCursor(
  cursor: string,
  validators: readonly ((part: string) => boolean)[],
): string[] {
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (parts.length !== validators.length || !parts.every((part, i) => validators[i]!(part))) {
    throw new InvalidCursorError();
  }
  return parts;
}

/** The common key: a timestamp (as `timestampText` returns it) and a UUID tiebreak. */
export interface TimeIdKey {
  readonly at: string;
  readonly id: string;
}

export function encodeTimeIdCursor(key: TimeIdKey): string {
  return encodeCursor([key.at, key.id]);
}

export function decodeTimeIdCursor(cursor: string): TimeIdKey {
  const [at, id] = decodeCursor(cursor, [isUtcTimestamp, isUuid]) as [string, string];
  return { at, id };
}

/**
 * Splits a `limit + 1` query result into the page and its `next_cursor`. Lists fetch one
 * extra row to learn whether another page exists.
 */
export function takePage<Row>(
  rows: readonly Row[],
  limit: number,
  keyOf: (row: Row) => string,
): { rows: Row[]; nextCursor: string | undefined } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > limit && last !== undefined ? keyOf(last) : undefined,
  };
}
