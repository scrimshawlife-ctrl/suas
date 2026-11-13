/**
 * What SUAS computes from a licence reading (suas-specs R10.1, proposal; §2.2, §3): the
 * keyed licence fingerprint and the identity match against the VA attempt. Both are
 * computed in the job worker, after which the licence number and birth date are dropped.
 */

import {
  fingerprint,
  fingerprintCandidates,
  type FingerprintKeyring,
  type KeyedHash,
} from './fingerprint-keys.js';
import type { LicenceReading, LicenceSecrets } from './licence-reader.js';
import { identityMatches } from './va-identity.js';

/** HMAC label for the licence fingerprint; a new normalization needs a new label. */
export const LICENCE_FINGERPRINT_LABEL = 'suas/licence/v1';

export const IDENTITY_MATCHES = ['YES', 'NO', 'UNKNOWN'] as const;
export type IdentityMatch = (typeof IDENTITY_MATCHES)[number];

/** Upper case A-Z and 0-9 only, so spacing or dashes printed in a number cannot split it. */
const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** `STATE|NUMBER`, or undefined when either was not read. */
function fingerprintValue(reading: LicenceReading, secrets: LicenceSecrets): string | undefined {
  const state = normalize(reading.fields.issuing_state.value ?? '');
  const number = normalize(secrets.licenceNumber ?? '');
  return state === '' || number === '' ? undefined : `${state}|${number}`;
}

/** The fingerprint to store (current key) and every hash an approved row may carry. */
export function licenceFingerprints(
  keyring: FingerprintKeyring,
  reading: LicenceReading,
  secrets: LicenceSecrets,
): { stored: KeyedHash; candidates: KeyedHash[] } | undefined {
  const value = fingerprintValue(reading, secrets);
  if (value === undefined) return undefined;
  return {
    stored: fingerprint(keyring, LICENCE_FINGERPRINT_LABEL, value),
    candidates: fingerprintCandidates(keyring, LICENCE_FINGERPRINT_LABEL, value),
  };
}

/**
 * §2.2: the licence's first name, last name and birth date hashed in the VA canonical form
 * under the key id stored on the VA attempt. UNKNOWN when a field was not read, the attempt
 * holds no hash (released) or its key is no longer held.
 */
export function identityMatch(
  keyring: FingerprintKeyring,
  reading: LicenceReading,
  secrets: LicenceSecrets,
  attempt: KeyedHash | undefined,
): IdentityMatch {
  const firstName = reading.fields.first_name.value;
  const lastName = reading.fields.last_name.value;
  const birthDate = secrets.birthDate;
  if (attempt === undefined || firstName === null || lastName === null || birthDate === null) {
    return 'UNKNOWN';
  }
  const matched = identityMatches(keyring, { firstName, lastName, birthDate }, attempt);
  return matched === undefined ? 'UNKNOWN' : matched ? 'YES' : 'NO';
}
