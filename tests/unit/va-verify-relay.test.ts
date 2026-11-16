/**
 * VA confirmation through the outside-VPC verify function (VA_CONFIRMATION_FLOW W9 item 4,
 * released in 0.10.0): the in-VPC relay adapter and the verify function handler. No test reaches
 * AWS or VA; people and keys are synthetic.
 */

import type { InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVaVerifyHandler, type VaVerifyLogRecord } from '../../src/aws/va-verify-lambda.js';
import {
  FixtureVeteranConfirmation,
  VA_CONFIRMATION_FIXTURE_ZIPS,
} from '../../src/identity/va-confirmation-fixture.js';
import type { FetchTransport } from '../../src/identity/va-confirmation-http.js';
import {
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
    secret?: string;
    answer?: (zip: string) => Response;
  } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const logs: VaVerifyLogRecord[] = [];
  let secretReads = 0;
  const transport: FetchTransport = {
    fetch(url, init) {
      calls.push({ url, init });
      const zip = (JSON.parse(init.body as string) as { zipCode: string }).zipCode;
      return Promise.resolve((options.answer ?? vaSandbox)(zip));
    },
  };
  const handler = createVaVerifyHandler({
    environment: 'environment' in options ? options.environment : 'STAGING',
    readSecret: () => {
      secretReads += 1;
      return Promise.resolve(options.secret ?? SECRET);
    },
    log: (record) => logs.push(record),
    transport,
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

const awsError = (name: string, httpStatusCode?: number): Error =>
  Object.assign(new Error(name), {
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

  it('never reads a crashed, empty or malformed answer as a more definite one', async () => {
    const cases: Array<[InvokeCommandOutput, string]> = [
      [
        answered({ errorType: 'Sandbox.Timedout' }, { FunctionError: 'Unhandled' }),
        'PROVIDER_UNAVAILABLE',
      ],
      [{ $metadata: {}, StatusCode: 200 }, 'PROVIDER_RESPONSE_INVALID'],
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

  it('refuses outside STAGING and LOCAL without reading the key or calling VA', async () => {
    for (const environment of ['TEST', 'PRODUCTION', undefined]) {
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
 * The deployed wiring (`handler`, default deps): the secret id comes from the environment and
 * only the Secrets Manager client is faked. Nothing it prints names the secret or a person.
 */
describe('the verify function as deployed', () => {
  const SECRET_ARN = 'arn:aws:secretsmanager:us-west-2:000000000000:secret:sentinel-arn-AbCdEf';

  async function coldStart(secretId: string | undefined) {
    vi.resetModules();
    const secretReads: unknown[] = [];
    vi.doMock('@aws-sdk/client-secrets-manager', () => ({
      SecretsManagerClient: class {
        send(command: { input: unknown }) {
          secretReads.push(command.input);
          return Promise.resolve({ SecretString: SECRET });
        }
      },
      GetSecretValueCommand: class {
        constructor(readonly input: unknown) {}
      },
    }));
    vi.stubEnv('SUAS_ENV', 'STAGING');
    vi.stubEnv('SUAS_VA_CONFIRMATION_SECRET_ID', secretId);
    const { handler } = await import('../../src/aws/va-verify-lambda.js');
    return { handler, secretReads };
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
    expect(fn.secretReads).toEqual([{ SecretId: SECRET_ARN }]);
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
});
