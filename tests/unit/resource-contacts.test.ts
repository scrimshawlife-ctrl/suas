/**
 * Resource contact list rules (no database): R8.8 crisis-number refusal, the three-contact
 * bound, and the single-contact mirror. V1_MVP_PROPOSAL.md R8.8, D-059.
 */

import { describe, expect, it } from 'vitest';
import {
  contactCrisisIssue,
  contactInputIssue,
  contactsFromRow,
  resolveContacts,
  type ResourceContact,
} from '../../src/fulfillment/index.js';

const phone = (value: string): ResourceContact => ({ kind: 'PHONE', value });

describe('contactCrisisIssue', () => {
  it.each(['911', '9-1-1', '988', '838255', 'tel:988', 'sms:838255', 'sms:838255?body=HOME'])(
    'refuses %s',
    (value) => {
      expect(contactCrisisIssue(value)).toContain('crisis number');
    },
  );

  it.each(['408-555-0100', 'Open 9 to 11', 'Call 988 if you are in crisis', 'a@example.invalid'])(
    'allows %s',
    (value) => {
      expect(contactCrisisIssue(value)).toBeUndefined();
    },
  );
});

describe('contactInputIssue', () => {
  it('accepts three contacts and refuses a fourth', () => {
    const three = [phone('408-555-0100'), phone('408-555-0101'), phone('408-555-0102')];
    expect(contactInputIssue({ contacts: three })).toBeUndefined();
    expect(contactInputIssue({ contacts: [...three, phone('408-555-0103')] })).toContain(
      'at most 3',
    );
  });

  it('refuses a crisis number in the list or as the single contact', () => {
    expect(contactInputIssue({ contacts: [phone('408-555-0100'), phone('988')] })).toContain(
      'crisis number',
    );
    expect(contactInputIssue({ contactMethod: '911', contactMethodKind: 'PHONE' })).toContain(
      'crisis number',
    );
  });

  it('refuses a single contact that disagrees with the first listed contact', () => {
    const contacts = [phone('408-555-0100')];
    const agreeing = { contacts, contactMethod: '408-555-0100', contactMethodKind: 'PHONE' };
    expect(contactInputIssue(agreeing)).toBeUndefined();
    expect(contactInputIssue({ contacts, contactMethod: '408-555-0199' })).toContain('must match');
  });
});

describe('resolveContacts', () => {
  it('mirrors the first listed contact into the single contact', () => {
    const contacts: ResourceContact[] = [
      phone('408-555-0100'),
      { kind: 'URL', value: 'https://a.example.invalid' },
    ];
    expect(resolveContacts({ contacts })).toEqual({
      contacts,
      contactMethod: '408-555-0100',
      contactMethodKind: 'PHONE',
    });
  });

  it('turns a lone contact into a one-entry list and keeps an absent kind absent', () => {
    expect(resolveContacts({ contactMethod: 'front desk' })).toEqual({
      contacts: [{ kind: 'FREEFORM', value: 'front desk' }],
      contactMethod: 'front desk',
      contactMethodKind: null,
    });
    expect(resolveContacts({})).toEqual({
      contacts: [],
      contactMethod: null,
      contactMethodKind: null,
    });
  });
});

describe('contactsFromRow', () => {
  it('falls back to the single contact when no list is stored', () => {
    expect(contactsFromRow(null, '408-555-0100', 'PHONE')).toEqual([phone('408-555-0100')]);
    expect(contactsFromRow([], null, null)).toEqual([]);
  });

  it('downgrades a legacy crisis number to recorded text', () => {
    expect(contactsFromRow([phone('988'), phone('408-555-0100')], '988', 'PHONE')).toEqual([
      { kind: 'FREEFORM', value: '988' },
      phone('408-555-0100'),
    ]);
  });
});
