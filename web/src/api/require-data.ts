import { ApiError } from './errors';

/**
 * The client rejects every non-2xx response, so `data` is only missing when a 2xx carried no
 * body where one was documented. Treat that as a server fault instead of returning undefined.
 */
export function requireData<T>(data: T | undefined, what: string): T {
  if (data === undefined) throw new ApiError(502, 'EMPTY_RESPONSE', `The server sent no ${what}.`);
  return data;
}
