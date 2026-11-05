import { describe, expect, it } from 'vitest';
import { COUNTY_OPTIONS, validateWelcome } from './welcome-form';

describe('welcome form', () => {
  it('accepts a name and a county', () => {
    expect(validateWelcome('Marcus T.', 'SANTA_CLARA')).toEqual({});
  });

  it('asks for both when empty', () => {
    expect(validateWelcome('   ', '')).toEqual({
      displayName: 'Enter the name other veterans will see.',
      county: 'Choose your county.',
    });
  });

  it('allows 40 characters and refuses 41', () => {
    expect(validateWelcome('a'.repeat(40), 'MERCED')).toEqual({});
    expect(validateWelcome('a'.repeat(41), 'MERCED').displayName).toBe(
      'Use 40 characters or fewer.',
    );
  });

  it('refuses a county the API does not know', () => {
    expect(validateWelcome('Marcus T.', 'FRESNO').county).toBe('Choose your county.');
  });

  it('lists the seven counties by human name', () => {
    expect(COUNTY_OPTIONS.map((option) => option.label)).toEqual([
      'Santa Clara',
      'San Mateo',
      'Alameda',
      'Santa Cruz',
      'San Benito',
      'Merced',
      'Stanislaus',
    ]);
  });
});
