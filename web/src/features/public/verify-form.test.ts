import { describe, expect, it } from 'vitest';
import {
  EMPTY_VERIFY_FORM,
  toConfirmBody,
  validateVerifyForm,
  type VerifyFormValues,
} from './verify-form';

const NOW = new Date('2026-11-10T12:00:00Z');

const valid: VerifyFormValues = {
  firstName: 'Mary',
  lastName: "O'Leary",
  birthMonth: '4',
  birthDay: '8',
  birthYear: '1966',
  street: '12 Example Way #4',
  city: 'San Jose',
  state: 'CA',
  zip: '00002',
};

const errorsFor = (changes: Partial<VerifyFormValues>) =>
  validateVerifyForm({ ...valid, ...changes }, NOW);

describe('validateVerifyForm', () => {
  it('accepts a complete form', () => {
    expect(validateVerifyForm(valid, NOW)).toEqual({});
  });

  it('asks for every field when the form is empty', () => {
    expect(Object.keys(validateVerifyForm(EMPTY_VERIFY_FORM, NOW)).sort()).toEqual(
      ['birthDate', 'city', 'firstName', 'lastName', 'state', 'street', 'zip'].sort(),
    );
  });

  it.each(['Mary2', 'José', "O''Leary", 'Mary-', ' -Mary'])(
    'refuses the name %j under the VA name pattern',
    (firstName) => {
      expect(errorsFor({ firstName }).firstName).toMatch(/letters only/);
    },
  );

  it('accepts a curly apostrophe and surrounding spaces in a name', () => {
    expect(errorsFor({ lastName: ' O’Leary ' })).toEqual({});
  });

  it.each([
    [{ birthYear: '2027' }, 'Your date of birth must be in the past.'],
    [
      { birthMonth: '11', birthDay: '10', birthYear: '2026' },
      'Your date of birth must be in the past.',
    ],
    [{ birthMonth: '2', birthDay: '30' }, /real date of birth/],
    [{ birthYear: '66' }, /4-digit year/],
    [{ birthMonth: '', birthDay: '', birthYear: '' }, 'Enter your date of birth.'],
  ] as const)('checks the birth date %j', (changes, message) => {
    expect(errorsFor(changes).birthDate).toMatch(message);
  });

  it('applies the street, city and ZIP patterns and the 256 character cap', () => {
    expect(errorsFor({ street: '12 Example Way @ 4' }).street).toMatch(/these marks only/);
    expect(errorsFor({ city: 'San Jose #2' }).city).toMatch(/these marks only/);
    expect(errorsFor({ zip: '941#0' }).zip).toMatch(/16 at most/);
    expect(errorsFor({ zip: '12345678901234567' }).zip).toMatch(/16 at most/);
    expect(errorsFor({ city: 'a'.repeat(257) }).city).toBe('Use 256 characters or fewer.');
  });

  it('only takes a listed state code', () => {
    expect(errorsFor({ state: 'California' }).state).toBe('Choose your state or territory.');
    expect(errorsFor({ state: 'PR' })).toEqual({});
  });
});

describe('toConfirmBody', () => {
  it('sends exactly the projection fields, YYYY-MM-DD, country USA and the notice version', () => {
    expect(toConfirmBody({ ...valid, lastName: ' O’Leary ', zip: ' 00002 ' })).toEqual({
      firstName: 'Mary',
      lastName: "O'Leary",
      birthDate: '1966-04-08',
      streetAddressLine1: '12 Example Way #4',
      city: 'San Jose',
      state: 'CA',
      zipCode: '00002',
      country: 'USA',
      noticeVersion: 'va-notice-v1',
    });
  });
});
