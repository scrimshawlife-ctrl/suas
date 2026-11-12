/**
 * Identity binding for VA confirmation (suas-specs #72 R9.1 D4; owner review of #236,
 * must-fix 1). The typed name must match the account's display name before VA is asked,
 * and each attempt VA answered keeps a keyed hash of the normalized name and birth date,
 * so one identity can verify only one account per tenant. R10.1 reuses the same hash.
 */

import {
  fingerprint,
  fingerprintCandidates,
  matchesStored,
  type FingerprintKeyring,
  type KeyedHash,
} from './fingerprint-keys.js';

/** HMAC label for the identity hash; a new normalization needs a new label. */
export const IDENTITY_HASH_LABEL = 'suas/identity/v1';

/**
 * NFKD, no combining marks, lower case, then only a-z: every separator VA's name pattern
 * allows (hyphen, apostrophe, slash, backslash, space) is dropped, so "Mary-Jane",
 * "Mary Jane" and "MaryJane" are one identity and cannot verify two accounts.
 */
export function normalizeNamePart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

export interface IdentityFields {
  readonly firstName: string;
  readonly lastName: string;
  /** ISO YYYY-MM-DD. */
  readonly birthDate: string;
}

const identityValue = (fields: IdentityFields): string =>
  [normalizeNamePart(fields.firstName), normalizeNamePart(fields.lastName), fields.birthDate].join(
    '|',
  );

/** The hash to store, under the current key. */
export const identityHash = (keyring: FingerprintKeyring, fields: IdentityFields) =>
  fingerprint(keyring, IDENTITY_HASH_LABEL, identityValue(fields));

/**
 * Whether these details hash to a stored identity hash, under the key id stored with it
 * (R10.1 compares a licence with the VA attempt it follows). Undefined when that key is
 * no longer held, so the caller cannot tell.
 */
export const identityMatches = (
  keyring: FingerprintKeyring,
  fields: IdentityFields,
  stored: KeyedHash,
): boolean | undefined =>
  matchesStored(keyring, IDENTITY_HASH_LABEL, identityValue(fields), stored);

/** The hashes a stored row may carry for this identity, current key and previous. */
export const identityHashCandidates = (keyring: FingerprintKeyring, fields: IdentityFields) =>
  fingerprintCandidates(keyring, IDENTITY_HASH_LABEL, identityValue(fields));

/**
 * The display name is the typed first name followed by the last name or its initial
 * ("Marcus Thompson" or "Marcus T."), compared in the same normalized form as the hash.
 * No display name never matches.
 */
export function displayNameMatches(
  displayName: string | undefined,
  fields: Pick<IdentityFields, 'firstName' | 'lastName'>,
): boolean {
  if (displayName === undefined) return false;
  const shown = normalizeNamePart(displayName);
  const first = normalizeNamePart(fields.firstName);
  const last = normalizeNamePart(fields.lastName);
  if (first === '' || last === '') return false;
  return shown === `${first}${last}` || shown === `${first}${last.charAt(0)}`;
}

export class VaNameMismatchError extends Error {
  readonly code = 'VA_NAME_MISMATCH';
  readonly httpStatus = 409;

  constructor() {
    super('The name you entered does not match the name on your account.');
    this.name = 'VaNameMismatchError';
  }
}

/** Generic on purpose: it never says or hints that another account holds the identity. */
export class VaIdentityAlreadyVerifiedError extends Error {
  readonly code = 'VA_IDENTITY_ALREADY_VERIFIED';
  readonly httpStatus = 409;

  constructor() {
    super("These details can't be used to verify this account.");
    this.name = 'VaIdentityAlreadyVerifiedError';
  }
}
