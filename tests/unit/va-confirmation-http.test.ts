/**
 * VA confirmation HTTP adapter against a fake transport: D035_VA_CONFIRMATION_ADAPTER.md
 * §14 security tests and §15 vectors, with the suas-specs #72 R9.1 (proposal) mapping.
 * All people and keys here are synthetic.
 */

import { describe, expect, it } from 'vitest';
import {
  createVaConfirmationHttpAdapter,
  MAX_RESPONSE_BYTES,
  type FetchTransport,
  type VaConfirmationLogRecord,
} from '../../src/identity/va-confirmation-http.js';
import {
  FixtureVeteranConfirmation,
  VA_CONFIRMATION_FIXTURE_ZIPS,
} from '../../src/identity/va-confirmation-fixture.js';
import {
  VA_CONFIRMATION_SANDBOX_BASE_URL,
  type VaConfirmationProjection,
} from '../../src/identity/va-confirmation.js';

const KEY = 'synthetic-sandbox-key-0000';
const PERSON: VaConfirmationProjection = {
  firstName: 'Sentinelfirst',
  lastName: "O'Sentinel",
  birthDate: '1970-01-31',
  streetAddressLine1: '1 Sentinel Way',
  city: 'Sentinelville',
  state: 'CA',
  country: 'USA',
  zipCode: '00000',
};

interface Call {
  url: string;
  init: RequestInit;
}

function json(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': contentType },
  });
}

function setup(answer: () => Promise<Response>) {
  const calls: Call[] = [];
  const logs: VaConfirmationLogRecord[] = [];
  const transport: FetchTransport = {
    fetch(url, init) {
      calls.push({ url, init });
      return answer();
    },
  };
  const adapter = createVaConfirmationHttpAdapter({
    baseUrl: VA_CONFIRMATION_SANDBOX_BASE_URL,
    apiKey: KEY,
    environment: 'SANDBOX',
    transport,
    logger: (record) => logs.push(record),
  });
  return { adapter, calls, logs };
}

const respond = (response: Response) => () => Promise.resolve(response);

describe('request shape (§4, §14 items 1, 4, 6)', () => {
  it('posts the eight projection fields to {base}/status with the key in the apikey header only', async () => {
    const { adapter, calls } = setup(respond(json(200, { veteran_status: 'confirmed' })));
    await adapter.confirm(PERSON);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${VA_CONFIRMATION_SANDBOX_BASE_URL}/status`);
    expect(call?.url).not.toContain(KEY);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.apikey).toBe(KEY);
    expect(headers['Content-Type']).toBe('application/json');
    const raw = call?.init.body as string;
    expect(JSON.parse(raw)).toEqual(PERSON);
    expect(raw).not.toContain(KEY);
  });

  it('refuses an unexpected or invalid field before any provider call (§14 item 5)', async () => {
    const { adapter, calls } = setup(respond(json(200, { veteran_status: 'confirmed' })));
    const extra = { ...PERSON, ssn: '000-00-0000' } as VaConfirmationProjection;
    const badName = { ...PERSON, firstName: 'R2-D2' };
    for (const projection of [extra, badName]) {
      expect(await adapter.confirm(projection)).toEqual({
        status: 'UNAVAILABLE',
        failureClass: 'REQUEST_INVALID',
      });
    }
    expect(calls).toHaveLength(0);
  });
});

describe('configuration fails closed (§6, §14 items 2, 3)', () => {
  it('refuses a missing key or a non-HTTPS base URL without calling the provider', () => {
    let called = false;
    const transport: FetchTransport = {
      fetch() {
        called = true;
        return Promise.resolve(json(200, {}));
      },
    };
    const build = (apiKey: string | undefined, baseUrl: string) => () =>
      createVaConfirmationHttpAdapter({ apiKey, baseUrl, environment: 'SANDBOX', transport });
    expect(build(undefined, VA_CONFIRMATION_SANDBOX_BASE_URL)).toThrow(/API_KEY is absent/);
    expect(build('  ', VA_CONFIRMATION_SANDBOX_BASE_URL)).toThrow(/API_KEY is absent/);
    expect(build(KEY, 'http://sandbox-api.va.gov/x')).toThrow(/not HTTPS/);
    try {
      build(KEY, 'http://sandbox-api.va.gov/x')();
    } catch (error) {
      expect(String(error)).not.toContain(KEY);
    }
    expect(called).toBe(false);
  });
});

describe('response normalization (§10, §11, §15 vectors)', () => {
  const vectors: [string, () => Promise<Response>, object][] = [
    ['confirmed', respond(json(200, { veteran_status: 'confirmed' })), { status: 'VERIFIED' }],
    [
      'confirmed with the string "null" reason and a deprecated id',
      respond(
        json(200, { veteran_status: 'confirmed', not_confirmed_reason: 'null', id: 'x-123' }),
      ),
      { status: 'VERIFIED' },
    ],
    ...(['PERSON_NOT_FOUND', 'NOT_TITLE_38', 'MORE_RESEARCH_REQUIRED'] as const).map(
      (reason): [string, () => Promise<Response>, object] => [
        `not confirmed ${reason}`,
        respond(json(200, { veteran_status: 'not confirmed', not_confirmed_reason: reason })),
        { status: 'NOT_CONFIRMED', notConfirmedReason: reason },
      ],
    ),
    [
      'the not_confirmed spelling',
      respond(json(200, { veteran_status: 'not_confirmed', not_confirmed_reason: 'NOT_TITLE_38' })),
      { status: 'NOT_CONFIRMED', notConfirmedReason: 'NOT_TITLE_38' },
    ],
    [
      'ERROR',
      respond(json(200, { veteran_status: 'not confirmed', not_confirmed_reason: 'ERROR' })),
      { status: 'UNAVAILABLE', notConfirmedReason: 'ERROR', failureClass: 'PROVIDER_UNAVAILABLE' },
    ],
    [
      'an unknown reason',
      respond(json(200, { veteran_status: 'not confirmed', not_confirmed_reason: 'NEW_THING' })),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_REASON_UNKNOWN' },
    ],
    [
      'a missing reason',
      respond(json(200, { veteran_status: 'not confirmed' })),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_REASON_UNKNOWN' },
    ],
    [
      'an unknown status',
      respond(json(200, { veteran_status: 'maybe' })),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_RESPONSE_INVALID' },
    ],
    [
      'malformed JSON',
      respond(json(200, '{"veteran_status":')),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_RESPONSE_INVALID' },
    ],
    [
      'a non-JSON content type',
      respond(json(200, { veteran_status: 'confirmed' }, 'text/html')),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_RESPONSE_INVALID' },
    ],
    // A 400 is our request or VA's, never a finding about the person (owner M2).
    [
      '400',
      respond(json(400, { errors: [] })),
      { status: 'UNAVAILABLE', failureClass: 'REQUEST_INVALID' },
    ],
    [
      '404',
      respond(json(404, {})),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_RESPONSE_INVALID' },
    ],
    [
      'a body over the 64 KiB cap',
      respond(json(200, { veteran_status: 'confirmed', pad: 'x'.repeat(MAX_RESPONSE_BYTES) })),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_RESPONSE_INVALID' },
    ],
    ...[401, 403].map((code): [string, () => Promise<Response>, object] => [
      String(code),
      respond(json(code, {})),
      { status: 'UNAVAILABLE', failureClass: 'AUTHENTICATION_REJECTED' },
    ]),
    ...[413, 415].map((code): [string, () => Promise<Response>, object] => [
      String(code),
      respond(json(code, {})),
      { status: 'UNAVAILABLE', failureClass: 'REQUEST_INVALID' },
    ]),
    [
      '429',
      respond(json(429, {})),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_RATE_LIMITED' },
    ],
    ...[500, 502, 503, 504].map((code): [string, () => Promise<Response>, object] => [
      String(code),
      respond(json(code, {})),
      { status: 'UNAVAILABLE', failureClass: 'PROVIDER_UNAVAILABLE' },
    ]),
    [
      'a timeout',
      () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
      { status: 'UNAVAILABLE', failureClass: 'TIMEOUT' },
    ],
    [
      'a network error',
      () => Promise.reject(new TypeError('fetch failed')),
      { status: 'UNAVAILABLE', failureClass: 'NETWORK_ERROR' },
    ],
  ];

  it.each(vectors)('%s', async (_name, answer, expected) => {
    const { adapter } = setup(answer);
    expect(await adapter.confirm(PERSON)).toEqual(expected);
  });

  it('never turns NOT_TITLE_38 into a finding of no service (§14 item 12)', async () => {
    const { adapter } = setup(
      respond(json(200, { veteran_status: 'not confirmed', not_confirmed_reason: 'NOT_TITLE_38' })),
    );
    const result = await adapter.confirm(PERSON);
    expect(Object.keys(result).sort()).toEqual(['notConfirmedReason', 'status']);
    expect(result.status).toBe('NOT_CONFIRMED');
  });
});

describe('logs (§13, §14 items 7, 8)', () => {
  it('logs only bounded fields: no key, projection value or provider body', async () => {
    const { adapter, logs } = setup(
      respond(json(200, { veteran_status: 'not confirmed', not_confirmed_reason: 'ERROR' })),
    );
    await adapter.confirm(PERSON);
    expect(logs).toEqual([
      {
        adapter: 'va-confirmation-http',
        adapter_version: 'va-veteran-confirmation-v1',
        provider_environment: 'SANDBOX',
        projection_id: 'VA_CONFIRMATION_V1_REQUIRED_ONLY',
        normalized_status: 'UNAVAILABLE',
        failure_class: 'PROVIDER_UNAVAILABLE',
        latency_bucket: 'lt_1s',
      },
    ]);
    const text = JSON.stringify(logs);
    for (const value of [KEY, ...Object.values(PERSON).filter((v) => v !== 'USA')]) {
      expect(text).not.toContain(value);
    }
  });
});

describe('fixture adapter', () => {
  it('answers by ZIP from its documented table, with no network', async () => {
    const fixture = new FixtureVeteranConfirmation();
    const at = (zipCode: string) => fixture.confirm({ ...PERSON, zipCode });
    expect(await at(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED)).toEqual({ status: 'VERIFIED' });
    expect(await at(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38)).toEqual({
      status: 'NOT_CONFIRMED',
      notConfirmedReason: 'NOT_TITLE_38',
    });
    expect((await at(VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR)).status).toBe('UNAVAILABLE');
    expect(await at(VA_CONFIRMATION_FIXTURE_ZIPS.REQUEST_INVALID)).toEqual({
      status: 'UNAVAILABLE',
      failureClass: 'REQUEST_INVALID',
    });
    // Any other ZIP fails closed (owner review d): never VERIFIED by default.
    expect(await at('95112')).toEqual({
      status: 'NOT_CONFIRMED',
      notConfirmedReason: 'PERSON_NOT_FOUND',
    });
    expect(fixture.providerEnvironment).toBe('NONE');
  });
});
