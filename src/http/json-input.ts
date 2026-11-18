/**
 * Checks on parsed request input that no single route schema owns. PostgreSQL refuses U+0000 in
 * text and jsonb, so NUL input is a 400 (API.md §6); the walkers are iterative for deep bodies.
 */

import type { FastifyInstance } from 'fastify';
import { errorBody, VALIDATION_FAILED } from './error-envelope.js';

const NUL = '\u0000';

/** Objects and arrays: the only values either walk has to open. */
function isContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/**
 * True when any string, or any object key, inside `value` holds U+0000. Arrays are walked by
 * value (an index cannot hold NUL) and scalars are never queued, which keeps a 1 MiB body fast.
 */
export function containsNul(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') {
      if (next.includes(NUL)) return true;
    } else if (Array.isArray(next)) {
      for (const entry of next as unknown[]) {
        if (typeof entry === 'string') {
          if (entry.includes(NUL)) return true;
        } else if (isContainer(entry)) pending.push(entry);
      }
    } else if (isContainer(next)) {
      for (const key of Object.keys(next)) {
        if (key.includes(NUL)) return true;
        pending.push((next as Record<string, unknown>)[key]);
      }
    }
  }
  return false;
}

/** Nesting depth of a JSON value: a scalar is 0, `{}` or `[]` is 1, `{"a":{}}` is 2. */
export function jsonDepth(value: unknown): number {
  if (!isContainer(value)) return 0;
  let deepest = 0;
  const pending: [object, number][] = [[value, 1]];
  while (pending.length > 0) {
    const [next, depth] = pending.pop() as [object, number];
    deepest = Math.max(deepest, depth);
    if (Array.isArray(next)) {
      for (const entry of next as unknown[]) {
        if (isContainer(entry)) pending.push([entry, depth + 1]);
      }
    } else {
      for (const key in next) {
        const entry = (next as Record<string, unknown>)[key];
        if (isContainer(entry)) pending.push([entry, depth + 1]);
      }
    }
  }
  return deepest;
}

/**
 * Refuses any request whose parsed body, query or path parameters hold U+0000: the `/api/v0`
 * JSON routes and the `/app` form routes alike, so no route prefix decides who is guarded.
 * One hook before every handler, rather than a rule repeated in each route schema. Header
 * values never get here: Node's HTTP parser answers 400 to a NUL in one.
 */
export function registerNulGuard(app: FastifyInstance): void {
  app.addHook('preValidation', async (request, reply) => {
    if (containsNul(request.body) || containsNul(request.query) || containsNul(request.params)) {
      return reply
        .status(400)
        .send(errorBody(VALIDATION_FAILED, 'Text must not contain the NUL character (U+0000).'));
    }
  });
}
