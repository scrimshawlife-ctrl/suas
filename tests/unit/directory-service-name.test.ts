import { describe, expect, it } from 'vitest';
import { directoryServiceNameCrisisIssue } from '../../src/fulfillment/resources.js';

describe('directory service names (SAFETY.md §2)', () => {
  it.each(['988', '988 Suicide & Crisis Lifeline', 'Veterans Crisis Line', 'Crisis Line'])(
    'rejects %s',
    (name) => {
      expect(directoryServiceNameCrisisIssue(name)).toMatch(/crisis line/i);
      expect(directoryServiceNameCrisisIssue(name.toUpperCase())).toMatch(/crisis line/i);
    },
  );

  it('allows an ordinary directory name', () => {
    expect(directoryServiceNameCrisisIssue('County food pantry')).toBeUndefined();
    expect(directoryServiceNameCrisisIssue('National Lifeline')).toBeUndefined();
  });
});
