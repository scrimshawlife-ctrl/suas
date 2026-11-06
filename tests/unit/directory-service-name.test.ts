import { describe, expect, it } from 'vitest';
import {
  directoryContactForRead,
  directoryServiceNameCrisisIssue,
  directoryServiceNameForDisplay,
  QUALIFIED_DIRECTORY_SERVICE_NAME,
} from '../../src/fulfillment/resources.js';

describe('directory service names (SAFETY.md §2)', () => {
  it.each([
    '911',
    '9-1-1',
    '988',
    '838255',
    '988 Suicide & Crisis Lifeline',
    'Veterans Crisis Line',
    'Crisis Line',
    'National Lifeline',
  ])('rejects %s', (name) => {
    expect(directoryServiceNameCrisisIssue(name)).toMatch(/crisis line/i);
    expect(directoryServiceNameCrisisIssue(name.toUpperCase())).toMatch(/crisis line/i);
    const shown = directoryServiceNameForDisplay(name);
    expect(shown).toBe(QUALIFIED_DIRECTORY_SERVICE_NAME);
    expect(directoryServiceNameCrisisIssue(shown)).toBeUndefined();
  });

  it('allows an ordinary directory name', () => {
    expect(directoryServiceNameCrisisIssue('County food pantry')).toBeUndefined();
    expect(directoryServiceNameForDisplay('County food pantry')).toBe('County food pantry');
  });

  it('keeps 911, 988, and 838255 out of a directory phone link', () => {
    for (const number of ['911', '988', '838255', '9-1-1']) {
      expect(directoryContactForRead(number, 'PHONE')).toEqual({
        contactMethod: number,
        contactMethodKind: 'FREEFORM',
      });
    }
    expect(directoryContactForRead('800-555-0142', 'PHONE')).toEqual({
      contactMethod: '800-555-0142',
      contactMethodKind: 'PHONE',
    });
  });
});
