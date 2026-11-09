import { describe, expect, it } from 'vitest';
import { adminScopeLine } from './scope';

describe('adminScopeLine', () => {
  it('names the synthetic environment classes only', () => {
    expect(adminScopeLine('STAGING')).toBe('Scope: Synthetic staging.');
    expect(adminScopeLine('LOCAL')).toBe('Scope: Local synthetic data.');
  });

  it('shows no line for any other class or an unreadable value', () => {
    for (const value of ['PRODUCTION', 'TEST', 'staging', '', null, undefined, 3]) {
      expect(adminScopeLine(value)).toBeUndefined();
    }
  });
});
