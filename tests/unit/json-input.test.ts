/**
 * The NUL guard and the depth walk run on every parsed `/api/v0` body, so their cost on the
 * largest body Fastify admits (bodyLimit, 1 MiB) must stay small next to JSON.parse itself.
 */

import { describe, expect, it } from 'vitest';
import { containsNul, jsonDepth } from '../../src/http/json-input.js';

const BODY_LIMIT = 1_048_576;

/** A JSON array of `unit` repeated until the text fills the body limit. */
function fullArray(unit: string): unknown {
  const count = Math.floor((BODY_LIMIT - 2) / (unit.length + 1));
  return JSON.parse(`[${Array<string>(count).fill(unit).join(',')}]`);
}

/** Fastest of several runs, so one scheduler pause does not decide the result. */
function bestMs(walk: () => unknown): number {
  let best = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now();
    walk();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe('guard walks over a body at the 1 MiB limit', () => {
  const bodies: Record<string, unknown> = {
    '100k-key object': Object.fromEntries(
      Array.from({ length: 100_000 }, (_, i) => [`k${i.toString(36)}`, 0]),
    ),
    '524k-number array': fullArray('0'),
    '349k-object array': fullArray('{}'),
  };

  it.each(Object.keys(bodies))('finish a %s within 50 ms', (name) => {
    const body = bodies[name];
    expect(bestMs(() => containsNul(body))).toBeLessThan(50);
    expect(bestMs(() => jsonDepth(body))).toBeLessThan(50);
  });
});

describe('containsNul', () => {
  it('finds U+0000 in a nested key, an array element and a lone NUL string', () => {
    expect(containsNul({ a: { 'b\u0000': 1 } })).toBe(true);
    expect(containsNul({ a: ['x', 'y\u0000'] })).toBe(true);
    expect(containsNul('\u0000')).toBe(true);
    expect(containsNul({ a: ['x', { b: 'y' }], n: 1, t: true, z: null })).toBe(false);
  });
});
