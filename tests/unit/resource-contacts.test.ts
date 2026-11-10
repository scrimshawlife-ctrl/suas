/**
 * Resource contact list rules (no database): R8.8 crisis-number refusal, the three-contact
 * bound, and the single-contact mirror. V1_MVP_PROPOSAL.md R8.8, D-059.
 */

import { describe, expect, it } from 'vitest';
import {
  contactCrisisIssue,
  contactInputIssue,
  contactsFromRow,
  contactValueIssue,
  resolveContacts,
  type ResourceContact,
} from '../../src/fulfillment/index.js';

const phone = (value: string): ResourceContact => ({ kind: 'PHONE', value });

describe('contactCrisisIssue', () => {
  it.each([
    '911',
    '9-1-1',
    '988',
    '838255',
    'tel:988',
    'sms:838255',
    'sms:838255?body=HOME',
    '+1 988',
    '1-911',
    '+1 (911)',
    'tel:+1988',
    '1 838255',
  ])('refuses %s', (value) => {
    expect(contactCrisisIssue(value)).toContain('crisis number');
  });

  it.each([
    '408-555-0100',
    '+1 408-555-0100',
    '1-911-555-0100',
    'Open 9 to 11',
    'Call 988 if you are in crisis',
    'a@example.invalid',
  ])('allows %s', (value) => {
    expect(contactCrisisIssue(value)).toBeUndefined();
  });
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

describe('contactValueIssue', () => {
  // Built so the source carries no literal script-url token.
  const scriptUrl = `java${'script'}:alert(1)`;
  const mixedScriptUrl = `Java${'Script'}:alert(1)`;

  it.each([
    scriptUrl,
    mixedScriptUrl,
    `  ${scriptUrl}`,
    'data:text/html,<b>hi</b>',
    'DATA:text/html;base64,PGI+aGk8L2I+',
    `vb${'script'}:msgbox(1)`,
    'ftp://files.example.invalid/form.pdf',
    'mailto:help@example.invalid',
    'pantry.example.invalid',
    'not a url',
  ])('refuses %s as a URL contact', (value) => {
    expect(contactValueIssue('URL', value)).toContain('http or https');
  });

  it.each(['https://pantry.example.invalid', 'http://pantry.example.invalid/hours?day=mon'])(
    'allows %s as a URL contact',
    (value) => {
      expect(contactValueIssue('URL', value)).toBeUndefined();
    },
  );

  it.each([
    'mailto:help@example.invalid',
    'help@example.invalid?subject=hi',
    'a@b.invalid, c@d.invalid',
    'help at example.invalid',
    'help@',
    '@example.invalid',
    `${scriptUrl}@example.invalid`,
    'help@example',
  ])('refuses %s as an EMAIL contact', (value) => {
    expect(contactValueIssue('EMAIL', value)).toContain('plain email address');
  });

  it.each(['help@pantry.example.invalid', 'first.last+intake@example.org'])(
    'allows %s as an EMAIL contact',
    (value) => {
      expect(contactValueIssue('EMAIL', value)).toBeUndefined();
    },
  );

  it('leaves PHONE and FREEFORM values to their own rules', () => {
    expect(contactValueIssue('PHONE', '408-555-0100')).toBeUndefined();
    expect(contactValueIssue('FREEFORM', scriptUrl)).toBeUndefined();
  });

  it('applies on the list and on the single contact, through contactInputIssue', () => {
    expect(contactInputIssue({ contacts: [{ kind: 'URL', value: scriptUrl }] })).toContain(
      'http or https',
    );
    expect(contactInputIssue({ contacts: [{ kind: 'URL', value: 'data:text/html,x' }] })).toContain(
      'http or https',
    );
    expect(contactInputIssue({ contactMethod: scriptUrl, contactMethodKind: 'URL' })).toContain(
      'http or https',
    );
    expect(
      contactInputIssue({ contactMethod: 'mailto:a@example.invalid', contactMethodKind: 'EMAIL' }),
    ).toContain('plain email address');
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
