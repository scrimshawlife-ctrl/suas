/**
 * Builds the VA confirmation port for this configuration (suas-specs #72 R9.1, proposal).
 * Undefined when disabled, so the confirm route answers 503. The fixture is LOCAL and TEST
 * only and the sandbox STAGING and LOCAL only, even if a caller builds a config the
 * startup schema would already have refused (D035 §5 "environment mismatch fails closed").
 * The sandbox also needs the approved projection (A27), so it refuses to start until then.
 */

import type { SuasConfig } from '../config/index.js';
import { FixtureVeteranConfirmation } from './va-confirmation-fixture.js';
import {
  createVaConfirmationHttpAdapter,
  type FetchTransport,
  type VaConfirmationLogger,
} from './va-confirmation-http.js';
import type { VeteranConfirmationPort } from './va-confirmation.js';
import {
  assertVaProjectionApproved,
  VENDORED_VA_PROJECTION,
  type VaProjectionArtifact,
} from './va-projection-approval.js';

export interface VeteranConfirmationPortOptions {
  readonly transport?: FetchTransport;
  readonly logger?: VaConfirmationLogger;
  /** The projection and approval to check; the vendored copies unless a test passes others. */
  readonly projection?: VaProjectionArtifact;
}

export function createVeteranConfirmationPort(
  config: SuasConfig,
  options: VeteranConfirmationPortOptions = {},
): VeteranConfirmationPort | undefined {
  const { mode, baseUrl, apiKey } = config.vaConfirmation;
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
    const { projection = VENDORED_VA_PROJECTION, ...adapterOptions } = options;
    assertVaProjectionApproved(projection);
    return createVaConfirmationHttpAdapter({
      baseUrl,
      apiKey,
      environment: 'SANDBOX',
      ...adapterOptions,
    });
  }
  return undefined;
}
