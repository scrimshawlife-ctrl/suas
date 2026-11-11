/**
 * The identity hash and name match behind one-identity-per-tenant (suas-specs #72 R9.1
 * D4). Every spelling VA's name pattern treats as the same name must hash the same, or a
 * second account could verify the identity again. Synthetic names and keys only.
 */

import { describe, expect, it } from 'vitest';
import {
  displayNameMatches,
  identityHash,
  type FingerprintKeyring,
} from '../../src/identity/index.js';

const KEYRING: FingerprintKeyring = {
  current: { id: 'unit-k1', secret: Buffer.alloc(32, 9).toString('base64') },
};
const hashOf = (firstName: string, lastName: string, birthDate = '1970-01-31') =>
  identityHash(KEYRING, { firstName, lastName, birthDate }).hash;

describe('identity hash (suas/identity/v1)', () => {
  const spellings: [string, [string, string][]][] = [
    [
      'Mary-Jane',
      [
        ['Mary-Jane', 'Doe'],
        ['Mary Jane', 'Doe'],
        ['MaryJane', 'Doe'],
        ['mary jane', 'Doe'],
      ],
    ],
    [
      "O'Brien",
      [
        ['Sean', "O'Brien"],
        ['Sean', 'OBrien'],
        ['Sean', 'O Brien'],
      ],
    ],
    [
      'José',
      [
        ['José', 'Garcia'],
        ['Jose', 'Garcia'],
      ],
    ],
  ];

  it.each(spellings)('gives one hash for every spelling of %s', (_name, names) => {
    expect(new Set(names.map(([first, last]) => hashOf(first, last))).size).toBe(1);
  });

  it('separates different people and birth dates, and keeps no value in the hash', () => {
    expect(hashOf('Mary', 'Doe')).not.toBe(hashOf('Mary', 'Dow'));
    expect(hashOf('Mary', 'Doe')).not.toBe(hashOf('Mary', 'Doe', '1970-02-01'));
    expect(hashOf('Mary', 'Doe')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('display name match', () => {
  it('accepts the first name with the last name or its initial, in the hash form', () => {
    const typed = { firstName: 'Mary-Jane', lastName: "O'Brien" };
    for (const shown of ['Mary-Jane O.', 'mary jane obrien', 'MaryJane O']) {
      expect(displayNameMatches(shown, typed), shown).toBe(true);
    }
    for (const shown of [undefined, 'Mary O.', 'Someone Else', 'Mary-Jane B.']) {
      expect(displayNameMatches(shown, typed), String(shown)).toBe(false);
    }
  });
});
