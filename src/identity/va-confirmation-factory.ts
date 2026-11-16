/**
 * Builds the VA confirmation port for this configuration (suas-specs #72 R9.1, released in 0.10.0).
 * Undefined when disabled, so the confirm route answers 503. The fixture is LOCAL and TEST
 * only and the sandbox STAGING and LOCAL only, even if a caller builds a config the
 * startup schema would already have refused (D035 §5 "environment mismatch fails closed").
 * The sandbox also needs the approved projection (A27) and refuses to start without it. With
 * a relay function set (STAGING, W9 item 4) the sandbox goes through the outside-VPC verify
 * function; without one (LOCAL) it calls VA directly.
 */

import type { SuasConfig } from '../config/index.js';
import { FixtureVeteranConfirmation } from './va-confirmation-fixture.js';
import {
  createVaConfirmationHttpAdapter,
  type FetchTransport,
  type VaConfirmationLogger,
} from './va-confirmation-http.js';
import {
  createVaConfirmationLambdaRelay,
  type LambdaInvokeClient,
} from './va-confirmation-lambda-relay.js';
import type { VeteranConfirmationPort } from './va-confirmation.js';
import {
  assertVaProjectionApproved,
  VENDORED_VA_PROJECTION,
  type VaProjectionArtifact,
} from './va-projection-approval.js';

export interface VeteranConfirmationPortOptions {
  readonly transport?: FetchTransport;
  readonly lambdaClient?: LambdaInvokeClient;
  readonly logger?: VaConfirmationLogger;
  /** The projection and approval to check; the vendored copies unless a test passes others. */
  readonly projection?: VaProjectionArtifact;
}

export function createVeteranConfirmationPort(
  config: SuasConfig,
  options: VeteranConfirmationPortOptions = {},
): VeteranConfirmationPort | undefined {
  const { mode, baseUrl, apiKey, relayFunction } = config.vaConfirmation;
  if (mode === 'fixture') {
    if (config.environment !== 'LOCAL' && config.environment !== 'TEST') {
      throw new Error('The VA confirmation fixture is refused outside LOCAL and TEST.');
    }
    return new FixtureVeteranConfirmation();
  }
  if (mode === 'sandbox') {
    if (config.environment !== 'STAGING' && config.environment !== 'LOCAL') {
      throw new Error(
        `The VA confirmation sandbox is allowed only in STAGING and LOCAL, not ${config.environment}.`,
      );
    }
    const { projection = VENDORED_VA_PROJECTION, transport, lambdaClient, logger } = options;
    assertVaProjectionApproved(projection);
    if (relayFunction !== undefined) {
      return createVaConfirmationLambdaRelay({
        functionName: relayFunction,
        region: config.aws.region,
        ...(lambdaClient !== undefined ? { client: lambdaClient } : {}),
        ...(logger !== undefined ? { logger } : {}),
      });
    }
    return createVaConfirmationHttpAdapter({
      baseUrl,
      apiKey,
      environment: 'SANDBOX',
      ...(transport !== undefined ? { transport } : {}),
      ...(logger !== undefined ? { logger } : {}),
    });
  }
  return undefined;
}
