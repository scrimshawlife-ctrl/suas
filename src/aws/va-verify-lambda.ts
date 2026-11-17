/**
 * VA verify function (VA_CONFIRMATION_FLOW W9 item 4, R9.2 option (b), released in 0.10.0). The
 * STAGING VPC has no internet egress, so this function runs outside it, with no database access,
 * and is the only code that reaches the VA sandbox. The API invokes it with one projection and
 * gets back only the normalized result and failure class.
 *
 * It holds the fixed sandbox base URL and reads the key from one Secrets Manager secret holding
 * JSON `{"SUAS_VA_CONFIRMATION_API_KEY": "..."}`, named by `SUAS_VA_CONFIRMATION_SECRET_ID` and
 * cached per container. It logs no projection value, key or response body (D035 §13), refuses
 * outside STAGING, and never throws.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import {
  createVaConfirmationHttpAdapter,
  type FetchTransport,
  type VaConfirmationLogRecord,
} from '../identity/va-confirmation-http.js';
import {
  VA_CONFIRMATION_API_KEY_PATTERN,
  VA_CONFIRMATION_SANDBOX_BASE_URL,
  type VaConfirmationFailureClass,
  type VeteranConfirmationPort,
} from '../identity/va-confirmation.js';
import {
  assertVaProjectionApproved,
  VENDORED_VA_PROJECTION,
} from '../identity/va-projection-approval.js';
import { toVaVerifyResponse, vaVerifyRequestSchema } from '../identity/va-verify-relay.js';

/** Only STAGING deploys this function (W9 item 4); LOCAL `sandbox` calls VA directly. */
const VERIFY_ENVIRONMENT = 'STAGING';

const secretSchema = z.object({
  SUAS_VA_CONFIRMATION_API_KEY: z.string().regex(VA_CONFIRMATION_API_KEY_PATTERN),
});

/** Content-free log lines only: D035 §13 telemetry, or why a call was refused. */
export type VaVerifyLogRecord =
  | ({ readonly msg: 'va_verify' } & VaConfirmationLogRecord)
  | { readonly msg: 'va_verify_refused'; readonly reason: string };

/** Test seams. Production reads the secret and calls the VA sandbox over HTTPS. */
export interface VaVerifyDeps {
  /** `SUAS_ENV` of this function. */
  readonly environment: string | undefined;
  readonly readSecret: () => Promise<string | undefined>;
  readonly log: (record: VaVerifyLogRecord) => void;
  readonly transport?: FetchTransport;
}

function defaultDeps(): VaVerifyDeps {
  const secretId = process.env.SUAS_VA_CONFIRMATION_SECRET_ID;
  const client = new SecretsManagerClient({});
  return {
    environment: process.env.SUAS_ENV,
    log: (record) => console.info(JSON.stringify(record)),
    readSecret: async () => {
      if (secretId === undefined || secretId === '') return undefined;
      const output = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      return output.SecretString;
    },
  };
}

const unavailable = (failureClass: VaConfirmationFailureClass): unknown =>
  toVaVerifyResponse({ status: 'UNAVAILABLE', failureClass });

/** Builds a handler with its own per-container adapter (and so key) cache. */
export function createVaVerifyHandler(
  deps: VaVerifyDeps = defaultDeps(),
): (event: unknown) => Promise<unknown> {
  let adapter: VeteranConfirmationPort | undefined;

  const refuse = (reason: string, failureClass: VaConfirmationFailureClass): unknown => {
    deps.log({ msg: 'va_verify_refused', reason });
    return unavailable(failureClass);
  };

  const loadAdapter = async (): Promise<VeteranConfirmationPort | undefined> => {
    if (adapter !== undefined) return adapter;
    try {
      // The sandbox sends nothing until the vendored projection is the approved one (A27).
      assertVaProjectionApproved(VENDORED_VA_PROJECTION);
      const raw = await deps.readSecret();
      const parsed = secretSchema.safeParse(raw === undefined ? undefined : JSON.parse(raw));
      if (!parsed.success) return undefined;
      adapter = createVaConfirmationHttpAdapter({
        baseUrl: VA_CONFIRMATION_SANDBOX_BASE_URL,
        apiKey: parsed.data.SUAS_VA_CONFIRMATION_API_KEY,
        environment: 'SANDBOX',
        logger: (record) => deps.log({ msg: 'va_verify', ...record }),
        ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
      });
      return adapter;
    } catch {
      return undefined;
    }
  };

  return async (event) => {
    if (deps.environment !== VERIFY_ENVIRONMENT) {
      return refuse('environment', 'CONFIGURATION_INVALID');
    }
    // Same check the API ran; nothing is sent for a body VA would refuse.
    const projection = vaVerifyRequestSchema.safeParse(event);
    if (!projection.success) return refuse('request', 'REQUEST_INVALID');
    // Until the real key is stored, nothing is sent and the answer is not an outage.
    const current = await loadAdapter();
    if (current === undefined) return refuse('not_configured', 'CONFIGURATION_INVALID');
    try {
      const result = await current.confirm(projection.data);
      // A refused key may have been rotated: read the secret again next time.
      if (result.failureClass === 'AUTHENTICATION_REJECTED') adapter = undefined;
      return toVaVerifyResponse(result);
    } catch {
      // The adapter does not throw; if it did, settle as the store settles a throwing port.
      return unavailable('NETWORK_ERROR');
    }
  };
}

export const handler = createVaVerifyHandler();
