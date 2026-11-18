/**
 * VA confirmation through the outside-VPC verify function (VA_CONFIRMATION_FLOW W9 item 4,
 * released in 0.10.0): the in-VPC relay adapter and the verify function handler. No test reaches
 * AWS or VA; people and keys are synthetic.
 */

import type { InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createVaVerifyHandler,
  VA_SECRET_READ_TIMEOUT_MS,
  type VaVerifyLogRecord,
} from '../../src/aws/va-verify-lambda.js';
import {
  FixtureVeteranConfirmation,
  VA_CONFIRMATION_FIXTURE_ZIPS,
} from '../../src/identity/va-confirmation-fixture.js';
import type { FetchTransport } from '../../src/identity/va-confirmation-http.js';
import {
  invokeFailureClass,
  VaConfirmationLambdaRelay,
  type LambdaInvokeClient,
} from '../../src/identity/va-confirmation-lambda-relay.js';
import {
  VA_CONFIRMATION_SANDBOX_BASE_URL,
  type VaConfirmationProjection,
} from '../../src/identity/va-confirmation.js';

const KEY = 'synthetic-sandbox-key-2222';
const SECRET = JSON.stringify({ SUAS_VA_CONFIRMATION_API_KEY: KEY });
const PERSON: VaConfirmationProjection = {
  firstName: 'Sentinelfirst',
  lastName: 'Sentinellast',
  birthDate: '1970-01-31',
  streetAddressLine1: '1 Sentinel Way',
  city: 'Sentinelville',
  state: 'CA',
  country: 'USA',
  zipCode: '00000',
};
const RESPONSE_SENTINEL = 'response-body-sentinel';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** What the VA sandbox answers for each W9 item 2 persona ZIP (a 400 for 00006). */
function vaSandbox(zip: string): Response {
  const notConfirmed = (reason: string) =>
    json(200, {
      veteran_status: 'not confirmed',
      not_confirmed_reason: reason,
      id: RESPONSE_SENTINEL,
    });
  const z = VA_CONFIRMATION_FIXTURE_ZIPS;
  if (zip === z.VERIFIED) return json(200, { veteran_status: 'confirmed', id: RESPONSE_SENTINEL });
  if (zip === z.NOT_TITLE_38) return notConfirmed('NOT_TITLE_38');
  if (zip === z.MORE_RESEARCH_REQUIRED) return notConfirmed('MORE_RESEARCH_REQUIRED');
  if (zip === z.UNAVAILABLE_ERROR) return notConfirmed('ERROR');
  if (zip === z.REQUEST_INVALID) return json(400, { errors: [RESPONSE_SENTINEL] });
  return notConfirmed('PERSON_NOT_FOUND');
}

function verifyFunction(
  options: {
    environment?: string | undefined;
    /** The stored SecretString, or a function giving it per read (a rotation). */
    secret?: string | (() => string | undefined);
    answer?: (zip: string, apikey: string) => Response;
    /** The function's clock, in ms; the real clock when absent. */
    now?: () => number;
  } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logs: VaVerifyLogRecord[] = [];
  let secretReads = 0;
  const transport: FetchTransport = {
    fetch(url, init) {
      calls.push({ url, init });
      const zip = (JSON.parse(init.body as string) as { zipCode: string }).zipCode;
      const apikey = (init.headers as Record<string, string>).apikey ?? '';
      return Promise.resolve((options.answer ?? vaSandbox)(zip, apikey));
    },
  };
  const handler = createVaVerifyHandler({
    environment: 'environment' in options ? options.environment : 'STAGING',
    readSecret: () => {
      secretReads += 1;
      const { secret = SECRET } = options;
      return Promise.resolve(typeof secret === 'function' ? secret() : secret);
    },
    log: (record) => logs.push(record),
    transport,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { handler, calls, logs, secretReads: () => secretReads };
}

/** A Lambda client that runs the verify function in-process, as Invoke would. */
class InProcessLambda implements LambdaInvokeClient {
  constructor(private readonly handler: (event: unknown) => Promise<unknown>) {}
  async send(command: InvokeCommand): Promise<InvokeCommandOutput> {
    const event: unknown = JSON.parse(
      new TextDecoder().decode(command.input.Payload as Uint8Array),
    );
    return answered(await this.handler(event));
  }
}

class ScriptedLambda implements LambdaInvokeClient {
  constructor(private readonly outcome: InvokeCommandOutput | Error) {}
  send(): Promise<InvokeCommandOutput> {
    return this.outcome instanceof Error
      ? Promise.reject(this.outcome)
      : Promise.resolve(this.outcome);
  }
}

function answered(value: unknown, extra: Partial<InvokeCommandOutput> = {}): InvokeCommandOutput {
  return {
    $metadata: {},
    StatusCode: 200,
    Payload: new TextEncoder().encode(JSON.stringify(value)) as NonNullable<
      InvokeCommandOutput['Payload']
    >,
    ...extra,
  };
}

const relay = (client: LambdaInvokeClient) =>
  new VaConfirmationLambdaRelay('suas-va-verify', { client });

const awsError = (name: string, httpStatusCode?: number, message = name): Error =>
  Object.assign(new Error(message), {
    name,
    ...(httpStatusCode !== undefined ? { $metadata: { httpStatusCode } } : {}),
  });

describe('VA confirmation through the verify function', () => {
  it('gives the same answer as the W9 fixture for every sandbox persona ZIP', async () => {
    const { handler, calls } = verifyFunction();
    const port = relay(new InProcessLambda(handler));
    const fixture = new FixtureVeteranConfirmation();
    for (const zipCode of [...Object.values(VA_CONFIRMATION_FIXTURE_ZIPS), '99999']) {
      const person = { ...PERSON, zipCode };
      expect(await port.confirm(person), zipCode).toEqual(await fixture.confirm(person));
    }
    expect(port.providerEnvironment).toBe('SANDBOX');
    // One VA call per confirm, to the fixed sandbox URL with the key from the secret.
    expect(calls).toHaveLength(7);
    for (const call of calls) {
      expect(call.url).toBe(`${VA_CONFIRMATION_SANDBOX_BASE_URL}/status`);
      expect((call.init.headers as Record<string, string>).apikey).toBe(KEY);
    }
  });

  it.each([
    ['AccessDeniedException', undefined, 'CONFIGURATION_INVALID'],
    ['ResourceNotFoundException', 404, 'CONFIGURATION_INVALID'],
    ['TooManyRequestsException', 429, 'PROVIDER_RATE_LIMITED'],
    ['TimeoutError', undefined, 'TIMEOUT'],
    ['AbortError', undefined, 'TIMEOUT'],
    ['ServiceException', 500, 'PROVIDER_UNAVAILABLE'],
    ['ECONNRESET', undefined, 'NETWORK_ERROR'],
  ])('maps an invoke that throws %s to UNAVAILABLE / %s', async (name, status, failureClass) => {
    expect(await relay(new ScriptedLambda(awsError(name, status))).confirm(PERSON)).toEqual({
      status: 'UNAVAILABLE',
      failureClass,
    });
  });

  it('stops waiting for the verify function after 18 s, as TIMEOUT', async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const hanging: LambdaInvokeClient = {
      send: (_command, options) =>
        new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => {
            reject(options.abortSignal?.reason as Error);
          });
        }),
    };
    const answer = relay(hanging).confirm(PERSON);
    expect(timeout).toHaveBeenCalledWith(18_000);
    deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await answer).toEqual({ status: 'UNAVAILABLE', failureClass: 'TIMEOUT' });
    timeout.mockRestore();
  });

  // Review of #326: a crash (FunctionError set, payload or not) is PROVIDER_UNAVAILABLE; an answer
  // that is absent, zero bytes, `{}` or malformed is PROVIDER_RESPONSE_INVALID (R14.5 proposal).
  it('never reads a crashed, empty or malformed answer as a more definite one', async () => {
    const cases: Array<[InvokeCommandOutput, string]> = [
      [
        answered({ errorType: 'Sandbox.Timedout' }, { FunctionError: 'Unhandled' }),
        'PROVIDER_UNAVAILABLE',
      ],
      [{ $metadata: {}, StatusCode: 200, FunctionError: 'Unhandled' }, 'PROVIDER_UNAVAILABLE'],
      [{ $metadata: {}, StatusCode: 200 }, 'PROVIDER_RESPONSE_INVALID'],
      [
        answered(undefined, {
          Payload: new Uint8Array() as NonNullable<InvokeCommandOutput['Payload']>,
        }),
        'PROVIDER_RESPONSE_INVALID',
      ],
      [answered({}), 'PROVIDER_RESPONSE_INVALID'],
      [answered('not json at all'), 'PROVIDER_RESPONSE_INVALID'],
      [answered({ status: 'VERIFIED', failure_class: 'TIMEOUT' }), 'PROVIDER_RESPONSE_INVALID'],
      [
        answered({ status: 'NOT_CONFIRMED', not_confirmed_reason: 'ERROR' }),
        'PROVIDER_RESPONSE_INVALID',
      ],
      [answered({ status: 'NOT_CONFIRMED' }), 'PROVIDER_RESPONSE_INVALID'],
      [
        answered({ status: 'UNAVAILABLE', failure_class: 'NEW_CLASS' }),
        'PROVIDER_RESPONSE_INVALID',
      ],
    ];
    for (const [output, failureClass] of cases) {
      expect(await relay(new ScriptedLambda(output)).confirm(PERSON)).toEqual({
        status: 'UNAVAILABLE',
        failureClass,
      });
    }
  });

  it.each(['Unhandled', 'Handled'])(
    'reads a %s function error as PROVIDER_UNAVAILABLE, even with a VERIFIED-shaped payload',
    async (FunctionError) => {
      const output = answered({ status: 'VERIFIED' }, { FunctionError });
      expect(await relay(new ScriptedLambda(output)).confirm(PERSON)).toEqual({
        status: 'UNAVAILABLE',
        failureClass: 'PROVIDER_UNAVAILABLE',
      });
    },
  );

  // Only STAGING deploys this function; LOCAL sandbox calls VA directly (W9 items 1 and 4).
  it('refuses outside STAGING, LOCAL included, without reading the key or calling VA', async () => {
    for (const environment of ['LOCAL', 'TEST', 'PRODUCTION', '', undefined]) {
      const fn = verifyFunction({ environment });
      expect(await fn.handler(PERSON)).toEqual({
        status: 'UNAVAILABLE',
        failure_class: 'CONFIGURATION_INVALID',
      });
      expect(fn.secretReads()).toBe(0);
      expect(fn.calls).toHaveLength(0);
    }
  });

  it('sends nothing until the key is stored, or for a body VA would refuse', async () => {
    const placeholder = verifyFunction({
      secret: JSON.stringify({ SUAS_VA_CONFIRMATION_API_KEY: '', placeholder: 'x' }),
    });
    expect(await placeholder.handler(PERSON)).toEqual({
      status: 'UNAVAILABLE',
      failure_class: 'CONFIGURATION_INVALID',
    });
    const fn = verifyFunction();
    expect(await fn.handler({ ...PERSON, ssn: '000-00-0000' })).toEqual({
      status: 'UNAVAILABLE',
      failure_class: 'REQUEST_INVALID',
    });
    expect([...placeholder.calls, ...fn.calls]).toHaveLength(0);
  });

  it('reads the key again after VA refuses it, and caches it otherwise', async () => {
    let refuse = true;
    const fn = verifyFunction({
      answer: () => (refuse ? json(401, {}) : json(200, { veteran_status: 'confirmed' })),
    });
    expect(await fn.handler(PERSON)).toEqual({
      status: 'UNAVAILABLE',
      failure_class: 'AUTHENTICATION_REJECTED',
    });
    refuse = false;
    expect(await fn.handler(PERSON)).toEqual({ status: 'VERIFIED' });
    expect(await fn.handler(PERSON)).toEqual({ status: 'VERIFIED' });
    expect(fn.secretReads()).toBe(2);
  });
  it('logs no projection value, key or response body', async () => {
    const fn = verifyFunction();
    const zips = [...Object.values(VA_CONFIRMATION_FIXTURE_ZIPS), '99999'];
    for (const zipCode of zips) await fn.handler({ ...PERSON, zipCode });
    await fn.handler({ ...PERSON, firstName: '' });
    const logged = JSON.stringify(fn.logs);
    expect(fn.logs.filter((r) => r.msg === 'va_verify')).toHaveLength(zips.length);
    for (const value of [...Object.values(PERSON), ...zips, KEY, RESPONSE_SENTINEL]) {
      if (value === 'USA' || value === 'CA') continue;
      expect(logged).not.toContain(value);
    }
    for (const record of fn.logs) {
      expect(Object.keys(record).sort()).toEqual(
        record.msg === 'va_verify'
          ? [
              'adapter',
              'adapter_version',
              'failure_class',
              'latency_bucket',
              'msg',
              'normalized_status',
              'projection_id',
              'provider_environment',
            ]
          : ['msg', 'reason'],
      );
    }
  });
});

/**
 * The per-container key cache and the stored secret. The cache lasts five minutes, and among VA
 * answers only AUTHENTICATION_REJECTED drops it sooner; a malformed secret fails closed as
 * CONFIGURATION_INVALID, is never cached, and nothing of it reaches a log, the answer or stdout.
 */
describe('the verify function secret', () => {
  const OLD_KEY = 'synthetic-old-key-3333';
  const NEW_KEY = 'synthetic-new-key-4444';
  const SECRET_SENTINEL = 'secret-sentinel-5555';
  const keySecret = (key: unknown) => JSON.stringify({ SUAS_VA_CONFIRMATION_API_KEY: key });
  const apikeys = (calls: Array<{ init: RequestInit }>) =>
    calls.map((call) => (call.init.headers as Record<string, string>).apikey);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([401, 403])('uses the rotated key after VA refuses the cached one (%s)', async (code) => {
    const stored = [OLD_KEY, NEW_KEY];
    const fn = verifyFunction({
      secret: () => keySecret(stored.shift() ?? NEW_KEY),
      answer: (_zip, apikey) =>
        apikey === NEW_KEY ? json(200, { veteran_status: 'confirmed' }) : json(code, {}),
    });
    expect(await fn.handler(PERSON)).toEqual({
      status: 'UNAVAILABLE',
      failure_class: 'AUTHENTICATION_REJECTED',
    });
    expect(await fn.handler(PERSON)).toEqual({ status: 'VERIFIED' });
    expect(await fn.handler(PERSON)).toEqual({ status: 'VERIFIED' });
    expect(apikeys(fn.calls)).toEqual([OLD_KEY, NEW_KEY, NEW_KEY]);
    expect(fn.secretReads()).toBe(2);
  });

  // A stored rotation reaches a warm container even while VA still takes the old key.
  it('reads the secret again once the cached key is five minutes old', async () => {
    let clock = 1_000_000;
    let stored = OLD_KEY;
    const fn = verifyFunction({
      secret: () => keySecret(stored),
      now: () => clock,
      answer: () => json(200, { veteran_status: 'confirmed' }),
    });
    const start = clock;
    expect(await fn.handler(PERSON)).toEqual({ status: 'VERIFIED' });
    stored = NEW_KEY;
    clock = start + 299_999;
    await fn.handler(PERSON);
    clock = start + 300_000;
    await fn.handler(PERSON);
    clock = start + 300_000 + 299_999;
    await fn.handler(PERSON);
    expect(apikeys(fn.calls)).toEqual([OLD_KEY, OLD_KEY, NEW_KEY, NEW_KEY]);
    expect(fn.secretReads()).toBe(2);
  });

  it('keeps the cached key through every other VA failure', async () => {
    const answers = [
      json(429, {}),
      json(500, {}),
      json(400, {}),
      json(404, {}),
      json(200, { veteran_status: 'not confirmed', not_confirmed_reason: 'ERROR' }),
      json(200, { unexpected: true }),
    ];
    const fn = verifyFunction({ answer: () => answers.shift() ?? json(500, {}) });
    for (let call = 0; call < 6; call += 1) {
      const result = (await fn.handler(PERSON)) as { status: string; failure_class: string };
      expect(result.status).toBe('UNAVAILABLE');
      expect(result.failure_class).not.toBe('AUTHENTICATION_REJECTED');
    }
    expect(fn.calls).toHaveLength(6);
    expect(fn.secretReads()).toBe(1);
  });

  it.each([
    ['invalid JSON', `{"SUAS_VA_CONFIRMATION_API_KEY": "${SECRET_SENTINEL}"`],
    // A JSON.parse error quotes this input, so printing the error would leak the key.
    ['a bare key, not JSON', SECRET_SENTINEL],
    ['no SUAS_VA_CONFIRMATION_API_KEY', JSON.stringify({ api_key: SECRET_SENTINEL })],
    ['a key VA would refuse', keySecret(`${SECRET_SENTINEL} with spaces`)],
    ['a key that is not a string', keySecret([SECRET_SENTINEL])],
    ['a JSON string, not an object', JSON.stringify(SECRET_SENTINEL)],
    ['no SecretString', undefined],
  ])('fails closed on a secret with %s, and reads it again next time', async (_label, stored) => {
    const printed: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void printed.push(String(args)));
    }
    let current = stored;
    const fn = verifyFunction({ secret: () => current });
    const result = await fn.handler(PERSON);
    expect(result).toEqual({ status: 'UNAVAILABLE', failure_class: 'CONFIGURATION_INVALID' });
    expect(fn.calls).toHaveLength(0);
    expect(fn.logs).toEqual([{ msg: 'va_verify_refused', reason: 'not_configured' }]);
    expect(JSON.stringify([result, fn.logs, printed])).not.toContain(SECRET_SENTINEL);
    // Not cached: once the operator stores a well-formed key, the next call uses it.
    current = SECRET;
    const verified = { ...PERSON, zipCode: VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED };
    expect(await fn.handler(verified)).toEqual({ status: 'VERIFIED' });
    expect(apikeys(fn.calls)).toEqual([KEY]);
    expect(fn.secretReads()).toBe(2);
  });
});

/**
 * Every D035 §11 class an invoke that did not return can get. Throttle -> PROVIDER_RATE_LIMITED
 * and Lambda 5xx -> PROVIDER_UNAVAILABLE are R14.5 proposal. The name decides before the status.
 */
describe('invokeFailureClass', () => {
  it.each([
    ['AccessDeniedException', 403],
    ['ResourceNotFoundException', 404],
    ['InvalidParameterValueException', 400],
    ['InvalidRequestContentException', 400],
    ['RequestTooLargeException', 413],
    ['UnsupportedMediaTypeException', 415],
  ])('a deployment fault %s (%s) is CONFIGURATION_INVALID, not an outage', (name, status) => {
    expect(invokeFailureClass(awsError(name, status))).toBe('CONFIGURATION_INVALID');
    expect(invokeFailureClass(awsError(name))).toBe('CONFIGURATION_INVALID');
  });

  it('a Lambda throttle is PROVIDER_RATE_LIMITED, with or without its 429', () => {
    expect(invokeFailureClass(awsError('TooManyRequestsException', 429))).toBe(
      'PROVIDER_RATE_LIMITED',
    );
    expect(invokeFailureClass(awsError('TooManyRequestsException'))).toBe('PROVIDER_RATE_LIMITED');
  });

  it.each([
    ['TimeoutError', undefined],
    ['AbortError', undefined],
    ['RequestTimeout', undefined],
    ['ModelTimeoutException', undefined],
    ['RequestTimeoutException', 408],
  ])('a timeout %s is TIMEOUT, even when it carries a status', (name, status) => {
    expect(invokeFailureClass(awsError(name, status))).toBe('TIMEOUT');
  });

  it.each([
    ['ServiceException', 500],
    ['ResourceNotReadyException', 502],
    ['EC2UnexpectedException', 502],
    ['SomeFutureLambdaException', 503],
    ['ResourceConflictException', 409],
  ])('any other answered error %s (%s) is PROVIDER_UNAVAILABLE', (name, status) => {
    expect(invokeFailureClass(awsError(name, status))).toBe('PROVIDER_UNAVAILABLE');
  });

  it.each([
    ['a lost connection', awsError('ECONNRESET')],
    ['a plain Error', new Error('socket hang up')],
    ['a non-numeric status', { name: 'Weird', $metadata: { httpStatusCode: '500' } }],
    ['a thrown string', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('anything without an HTTP status (%s) is NETWORK_ERROR', (_label, error) => {
    expect(invokeFailureClass(error)).toBe('NETWORK_ERROR');
  });
});

/**
 * The deployed wiring (`handler`, default deps): the secret id comes from the environment and
 * only the Secrets Manager client is faked. Nothing it prints names the secret or a person.
 */
describe('the verify function as deployed', () => {
  const SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:000000000000:secret:sentinel-arn-AbCdEf';

  /**
   * `failures` are what GetSecretValue throws on its first reads ('hang': waits for its abort
   * signal); later reads return SECRET.
   */
  async function coldStart(secretId: string | undefined, failures: Array<Error | 'hang'> = []) {
    vi.resetModules();
    const secretReads: unknown[] = [];
    const clientConfigs: unknown[] = [];
    vi.doMock('@aws-sdk/client-secrets-manager', () => ({
      SecretsManagerClient: class {
        constructor(config: unknown) {
          clientConfigs.push(config);
        }
        send(command: { input: unknown }, options?: { abortSignal?: AbortSignal }) {
          secretReads.push(command.input);
          const failure = failures.shift();
          if (failure === 'hang') {
            return new Promise((_resolve, reject) => {
              options?.abortSignal?.addEventListener('abort', () => {
                reject(options.abortSignal?.reason as Error);
              });
            });
          }
          return failure !== undefined
            ? Promise.reject(failure)
            : Promise.resolve({ SecretString: SECRET });
        }
      },
      GetSecretValueCommand: class {
        constructor(readonly input: unknown) {}
      },
    }));
    vi.stubEnv('SUAS_ENV', 'STAGING');
    vi.stubEnv('SUAS_VA_CONFIRMATION_SECRET_ID', secretId);
    const { handler } = await import('../../src/aws/va-verify-lambda.js');
    return { handler, secretReads, clientConfigs };
  }

  afterEach(() => {
    vi.doUnmock('@aws-sdk/client-secrets-manager');
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends nothing without a secret id, and prints no secret id, key or projection value', async () => {
    const printed: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args) => void printed.push(String(args)));
    }
    const vaCalls: RequestInit[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      vaCalls.push(init);
      return Promise.resolve(json(200, { veteran_status: 'confirmed', id: RESPONSE_SENTINEL }));
    });

    for (const unset of [undefined, '']) {
      const fn = await coldStart(unset);
      expect(await fn.handler(PERSON)).toEqual({
        status: 'UNAVAILABLE',
        failure_class: 'CONFIGURATION_INVALID',
      });
      expect(fn.secretReads).toEqual([]);
    }
    expect(vaCalls).toHaveLength(0);

    const fn = await coldStart(SECRET_ARN);
    expect(await fn.handler(PERSON)).toEqual({ status: 'VERIFIED' });
    expect(fn.secretReads).toEqual([{ SecretId: SECRET_ARN, VersionStage: 'AWSCURRENT' }]);
    expect(vaCalls).toHaveLength(1);
    const logged = printed.join('\n');
    expect(printed.length).toBeGreaterThan(0);
    for (const value of [
      SECRET_ARN,
      'sentinel-arn',
      KEY,
      RESPONSE_SENTINEL,
      ...Object.values(PERSON),
    ]) {
      if (value === 'USA' || value === 'CA') continue;
      expect(logged).not.toContain(value);
    }
  });

  // R14.5 owner question: a failed read answers CONFIGURATION_INVALID today, a throttle included,
  // not an outage class. These pin that mapping until the owner rules on it.
  it.each([
    ['ResourceNotFoundException', 'the secret was deleted or the id is wrong'],
    ['ThrottlingException', 'GetSecretValue was throttled'],
  ])(
    'fails closed when GetSecretValue throws %s (%s), and reads it again next time',
    async (name) => {
      const printed: string[] = [];
      for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, level).mockImplementation((...args) => void printed.push(String(args)));
      }
      const vaCalls: RequestInit[] = [];
      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
        vaCalls.push(init);
        return Promise.resolve(json(200, { veteran_status: 'confirmed' }));
      });
      const fn = await coldStart(SECRET_ARN, [awsError(name, 400, `${name}: ${SECRET_ARN}`)]);

      const result = await fn.handler(PERSON);
      expect(result).toEqual({ status: 'UNAVAILABLE', failure_class: 'CONFIGURATION_INVALID' });
      expect(vaCalls).toHaveLength(0);
      expect(printed).toEqual([
        JSON.stringify({ msg: 'va_verify_refused', reason: 'not_configured' }),
      ]);
      expect(JSON.stringify([result, printed])).not.toMatch(/sentinel-arn|synthetic-sandbox-key/);

      // Not cached: the next call reads the secret again and reaches VA.
      expect(await fn.handler(PERSON)).toEqual({ status: 'VERIFIED' });
      expect(fn.secretReads).toEqual([
        { SecretId: SECRET_ARN, VersionStage: 'AWSCURRENT' },
        { SecretId: SECRET_ARN, VersionStage: 'AWSCURRENT' },
      ]);
      expect(vaCalls).toHaveLength(1);
    },
  );

  // Review of #326: the read is bounded (one retry, each attempt and the whole read), so it and
  // the 10 s VA call fit in the 15 s function timeout (ordering pinned in infra/test/va-verify.test.ts).
  it('reads the secret with bounded attempts and gives up a hung read as CONFIGURATION_INVALID', async () => {
    const printed: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((...args) => void printed.push(String(args)));
    const vaCalls: RequestInit[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      vaCalls.push(init);
      return Promise.resolve(json(200, { veteran_status: 'confirmed' }));
    });
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const fn = await coldStart(SECRET_ARN, ['hang']);
    expect(fn.clientConfigs).toEqual([
      { maxAttempts: 2, requestHandler: { connectionTimeout: 500, requestTimeout: 1_000 } },
    ]);

    const answer = fn.handler(PERSON);
    expect(timeout).toHaveBeenCalledWith(VA_SECRET_READ_TIMEOUT_MS);
    expect(VA_SECRET_READ_TIMEOUT_MS).toBe(3_000);
    deadline.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    expect(await answer).toEqual({ status: 'UNAVAILABLE', failure_class: 'CONFIGURATION_INVALID' });
    expect(vaCalls).toHaveLength(0);
    expect(printed).toEqual([
      JSON.stringify({ msg: 'va_verify_refused', reason: 'not_configured' }),
    ]);
  });
});
