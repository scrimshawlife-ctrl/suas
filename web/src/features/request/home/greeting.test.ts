import { describe, expect, it } from 'vitest';
import { greeting } from './greeting';

const at = (hour: number) => new Date(2026, 10, 4, hour, 30);

describe('greeting', () => {
  it('uses the first word of the display name and the local time of day', () => {
    expect(greeting('Marcus T.', at(7))).toBe('Good morning, Marcus.');
    expect(greeting('Marcus T.', at(12))).toBe('Good afternoon, Marcus.');
    expect(greeting('Marcus T.', at(17))).toBe('Good afternoon, Marcus.');
    expect(greeting('Marcus T.', at(18))).toBe('Good evening, Marcus.');
  });

  it('drops the name when there is none', () => {
    expect(greeting(null, at(9))).toBe('Good morning.');
  });
});
