/**
 * Keyed fingerprints of personal data under `SUAS_FINGERPRINT_KEY` (suas-specs #72 R9.1
 * data table; owner review of #73, item 15).
 *
 * Each purpose has its own label, and the stored hash is HMAC-SHA256(HMAC(key, label),
 * value) next to the key id that made it. Writes use the current key. Reads and
 * uniqueness checks try the current key and, during a rotation, the verify-only previous
 * key, so a stored hash is still recognized by its key id.
 */

import { createHmac } from 'node:crypto';

export interface FingerprintKey {
  readonly id: string;
  /** Base64 key material, at least 32 bytes decoded. */
  readonly secret: string;
}

export interface FingerprintKeyring {
  readonly current: FingerprintKey;
  /** Verify-only during a rotation; never used to write. */
  readonly previous?: FingerprintKey;
}

export interface KeyedHash {
  readonly hash: string;
  readonly keyId: string;
}

function keyedHash(key: FingerprintKey, label: string, value: string): KeyedHash {
  const purposeKey = createHmac('sha256', Buffer.from(key.secret, 'base64'))
    .update(label, 'utf8')
    .digest();
  return {
    hash: createHmac('sha256', purposeKey).update(value, 'utf8').digest('hex'),
    keyId: key.id,
  };
}

/** The hash to store: always under the current key. */
export function fingerprint(keyring: FingerprintKeyring, label: string, value: string): KeyedHash {
  return keyedHash(keyring.current, label, value);
}

/** Every hash a stored row may carry for this value: current key first, then previous. */
export function fingerprintCandidates(
  keyring: FingerprintKeyring,
  label: string,
  value: string,
): KeyedHash[] {
  const keys =
    keyring.previous === undefined ? [keyring.current] : [keyring.current, keyring.previous];
  return keys.map((key) => keyedHash(key, label, value));
}

/**
 * Whether a stored hash matches this value. Undefined when its key id is neither the
 * current nor the previous key, so the caller cannot tell (for example, after a rotation
 * dropped the old key).
 */
export function matchesStored(
  keyring: FingerprintKeyring,
  label: string,
  value: string,
  stored: KeyedHash,
): boolean | undefined {
  const candidate = fingerprintCandidates(keyring, label, value).find(
    (item) => item.keyId === stored.keyId,
  );
  return candidate === undefined ? undefined : candidate.hash === stored.hash;
}
