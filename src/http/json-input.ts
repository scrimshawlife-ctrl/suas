/**
 * Checks on parsed request JSON that no single route schema owns. PostgreSQL refuses U+0000 in
 * text and jsonb, so NUL input is a 400 (API.md §6); the walkers are iterative for deep bodies.
 */

import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../release/pins.js';
import { errorBody, VALIDATION_FAILED } from './error-envelope.js';

const NUL = '\u0000';

/** True when any string, or any object key, inside `value` holds U+0000. */
export function containsNul(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') {
      if (next.includes(NUL)) return true;
    } else if (typeof next === 'object' && next !== null) {
      for (const [key, entry] of Object.entries(next)) {
        if (key.includes(NUL)) return true;
        pending.push(entry);
      }
    }
  }
  return false;
}

/** Nesting depth of a JSON value: a scalar is 0, `{}` or `[]` is 1, `{"a":{}}` is 2. */
export function jsonDepth(value: unknown): number {
  let deepest = 0;
  const pending: [unknown, number][] = [[value, 0]];
  while (pending.length > 0) {
    const [next, depth] = pending.pop() as [unknown, number];
    if (typeof next !== 'object' || next === null) continue;
    deepest = Math.max(deepest, depth + 1);
    for (const entry of Object.values(next)) pending.push([entry, depth + 1]);
  }
  return deepest;
}

/**
 * Refuses an `/api/v0` request whose parsed body, query or path parameters hold U+0000.
 * One hook before every handler, rather than a rule repeated in each route schema.
 */
export function registerNulGuard(app: FastifyInstance): void {
  app.addHook('preValidation', async (request, reply) => {
    if (!request.url.startsWith(API_PREFIX)) return;
    if (containsNul(request.body) || containsNul(request.query) || containsNul(request.params)) {
      return reply
        .status(400)
        .send(errorBody(VALIDATION_FAILED, 'Text must not contain the NUL character (U+0000).'));
    }
  });
}
