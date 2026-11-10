/**
 * Builds the VA confirmation port for this configuration (suas-specs #72 R9.1, proposal).
 * Undefined when disabled, so the confirm route answers 503. The fixture is LOCAL and TEST
 * only and the sandbox STAGING and LOCAL only, even if a caller builds a config the
 * startup schema would already have refused (D035 §5 "environment mismatch fails closed").
 */

import type { SuasConfig } from '../config/index.js';
import { FixtureVeteranConfirmation } from './va-confirmation-fixture.js';
import {
  createVaConfirmationHttpAdapter,
  type FetchTransport,
  type VaConfirmationLogger,
} from './va-confirmation-http.js';
import type { VeteranConfirmationPort } from './va-confirmation.js';

export interface VeteranConfirmationPortOptions {
  readonly transport?: FetchTransport;
  readonly logger?: VaConfirmationLogger;
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
    return createVaConfirmationHttpAdapter({
      baseUrl,
      apiKey,
      environment: 'SANDBOX',
      ...options,
    });
  }
  return undefined;
}
