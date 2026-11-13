/**
 * Builds the licence reader for this configuration (suas-specs R10.1, proposal; L9.1).
 * Undefined when disabled, so the licence path is closed. The fixture is LOCAL and TEST
 * only and Scry LOCAL and STAGING only, even for a config the startup schema refused.
 */

import type { SuasConfig } from '../config/index.js';
import { FixtureLicenceReader } from './licence-reader-fixture.js';
import type { LicenceReaderPort } from './licence-reader.js';
import { ScryLicenceReader } from './licence-reader-scry.js';
import type { FetchTransport } from './va-confirmation-http.js';

export function createLicenceReaderPort(
  config: SuasConfig,
  options: { readonly transport?: FetchTransport } = {},
): LicenceReaderPort | undefined {
  const { mode, scryBaseUrl, scryApiToken } = config.licenceReader;
  if (mode === 'fixture') {
    if (config.environment !== 'LOCAL' && config.environment !== 'TEST') {
      throw new Error('The licence reader fixture is refused outside LOCAL and TEST.');
    }
    return new FixtureLicenceReader();
  }
  if (mode === 'scry') {
    if (config.environment !== 'LOCAL' && config.environment !== 'STAGING') {
      throw new Error(
        `The Scry licence reader is allowed only in LOCAL and STAGING, not ${config.environment}.`,
      );
    }
    return new ScryLicenceReader({
      baseUrl: scryBaseUrl,
      apiToken: scryApiToken,
      // Scry runs only in LOCAL and STAGING, so STAGING is where the marker is required.
      requireMarker: config.environment !== 'LOCAL',
      syntheticIin: config.licenceReader.syntheticIin,
      ...options,
    });
  }
  return undefined;
}
