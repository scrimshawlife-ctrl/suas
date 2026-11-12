/**
 * The shared keyset cursor (API.md §5): an exact round trip, and a 400-class error for any
 * cursor whose parts would not survive the SQL casts.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  decodeTimeIdCursor,
  encodeCursor,
  encodeTimeIdCursor,
  InvalidCursorError,
  isUuid,
  takePage,
} from '../../src/db/cursor.js';

const ID = '7d0f2b5e-3c1a-4e8b-9f6d-0a1b2c3d4e5f';

describe('keyset cursor', () => {
  it('round-trips a microsecond timestamp and id unchanged', () => {
    const key = { at: '2026-11-12T08:15:30.123456Z', id: ID };
    expect(decodeTimeIdCursor(encodeTimeIdCursor(key))).toEqual(key);
  });

  it('still reads a millisecond cursor issued before the shared helper', () => {
    const legacy = encodeCursor(['2026-11-12T08:15:30.123Z', ID]);
    expect(decodeTimeIdCursor(legacy).at).toBe('2026-11-12T08:15:30.123Z');
  });

  it.each([
    ['garbage', 'not-a-cursor'],
    ['an impossible date', encodeCursor(['2026-02-30T00:00:00.000000Z', ID])],
    ['a non-UTC time', encodeCursor(['2026-11-12T08:15:30.123456+01:00', ID])],
    ['a bad id', encodeCursor(['2026-11-12T08:15:30.123456Z', 'x'])],
    ['an extra part', encodeCursor(['2026-11-12T08:15:30.123456Z', ID, ID])],
  ])('rejects %s', (_label, cursor) => {
    expect(() => decodeTimeIdCursor(cursor)).toThrow(InvalidCursorError);
  });

  it('checks each part with its own validator', () => {
    const cursor = encodeCursor(['1', '', ID]);
    expect(decodeCursor(cursor, [(p) => p === '1', (p) => p === '', isUuid])).toEqual([
      '1',
      '',
      ID,
    ]);
    expect(() => decodeCursor(cursor, [(p) => p === '0', (p) => p === '', isUuid])).toThrow(
      InvalidCursorError,
    );
  });

  it('gives a next cursor only when the extra row exists', () => {
    const key = (n: number) => `k${n}`;
    expect(takePage([1, 2, 3], 2, key)).toEqual({ rows: [1, 2], nextCursor: 'k2' });
    expect(takePage([1, 2], 2, key)).toEqual({ rows: [1, 2], nextCursor: undefined });
  });
});
