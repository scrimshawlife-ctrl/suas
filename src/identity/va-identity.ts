/**
 * Identity binding for VA confirmation (suas-specs #72 R9.1 D4; owner review of #236,
 * must-fix 1). The typed name must match the account's display name before VA is asked,
 * and each attempt VA answered keeps a keyed hash of the normalized name and birth date,
 * so one identity can verify only one account per tenant. R10.1 reuses the same hash.
 */

import { fingerprint, fingerprintCandidates, type FingerprintKeyring } from './fingerprint-keys.js';

/**
 * HMAC label for the identity hash; a new normalization needs a new label. The joined-name
 * form and the letter folds below changed the value under this same label: nothing using it
 * is deployed or released, so no stored hash needs the old form.
 */
export const IDENTITY_HASH_LABEL = 'suas/identity/v1';

/** Letters NFKD keeps whole, folded to their usual a-z spelling (after lower-casing). */
const LETTER_FOLDS: Readonly<Record<string, string>> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  ł: 'l',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ı: 'i',
  ŋ: 'n',
};
const FOLDABLE = new RegExp(`[${Object.keys(LETTER_FOLDS).join('')}]`, 'gu');

/**
 * Canonical name form (VA_CONFIRMATION_FLOW §2.2 item 1): lower case, NFKD, no combining
 * marks, the letter folds, then only a-z. Every separator VA's name pattern allows is
 * dropped, so "Mary-Jane", "Mary Jane" and "MaryJane" are one identity; "Straße" is
 * "strasse" and "Østby" is "ostby". Lower-casing first also folds ẞ, Ø, Ł and the like.
 */
export function normalizeNamePart(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(FOLDABLE, (letter) => LETTER_FOLDS[letter] ?? '')
    .replace(/[^a-z]/g, '');
}

export interface IdentityFields {
  readonly firstName: string;
  readonly lastName: string;
  /** ISO YYYY-MM-DD. */
  readonly birthDate: string;
}

/**
 * The value under the hash: the first and last name as one string, then `|` and the birth
 * date. One string, so "Mary Jane" + "Smith" and "Mary" + "Jane Smith" are one identity.
 */
export const identityCanonicalForm = (fields: IdentityFields): string =>
  `${normalizeNamePart(fields.firstName)}${normalizeNamePart(fields.lastName)}|${fields.birthDate}`;

/** The hash to store, under the current key. */
export const identityHash = (keyring: FingerprintKeyring, fields: IdentityFields) =>
  fingerprint(keyring, IDENTITY_HASH_LABEL, identityCanonicalForm(fields));

/** The hashes a stored row may carry for this identity, current key and previous. */
export const identityHashCandidates = (keyring: FingerprintKeyring, fields: IdentityFields) =>
  fingerprintCandidates(keyring, IDENTITY_HASH_LABEL, identityCanonicalForm(fields));

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
