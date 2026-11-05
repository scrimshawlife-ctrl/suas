import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorFromResponse, hasApiCode, isApiError } from './errors';

describe('apiErrorFromResponse', () => {
  it('reads code and message from the error envelope', async () => {
    const error = await apiErrorFromResponse(
      new Response(
        JSON.stringify({ error: { code: 'COUNTY_REQUIRED', message: 'Pick a county.' } }),
        {
          status: 422,
        },
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 422,
      code: 'COUNTY_REQUIRED',
      message: 'Pick a county.',
    });
    expect(isApiError(error)).toBe(true);
    expect(hasApiCode(error, 'COUNTY_REQUIRED')).toBe(true);
  });

  it('falls back to a status code when the body is not JSON', async () => {
    const error = await apiErrorFromResponse(new Response('<html>', { status: 502 }));
    expect(error).toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('ignores an envelope whose fields are not strings', async () => {
    const error = await apiErrorFromResponse(
      new Response(JSON.stringify({ error: { code: 7, message: null } }), { status: 400 }),
    );
    expect(error.code).toBe('HTTP_400');
    expect(typeof error.message).toBe('string');
  });

  it('reads retry-after seconds on a 429 and ignores a missing or non-numeric value', async () => {
    const limited = await apiErrorFromResponse(
      new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Slow down.' } }), {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
    );
    expect(limited.retryAfterSeconds).toBe(120);
    const dated = await apiErrorFromResponse(
      new Response('', {
        status: 429,
        headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' },
      }),
    );
    expect(dated.retryAfterSeconds).toBeNull();
    const plain = await apiErrorFromResponse(new Response('', { status: 500 }));
    expect(plain.retryAfterSeconds).toBeNull();
  });
});
