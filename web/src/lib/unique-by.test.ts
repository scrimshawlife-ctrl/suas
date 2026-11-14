import { describe, expect, it } from 'vitest';
import { uniqueBy } from './unique-by';

describe('uniqueBy (r247 F1)', () => {
  it('keeps the first copy of each key, in order', () => {
    const rows = [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'a', v: 2 },
      { id: 'c', v: 1 },
      { id: 'b', v: 2 },
    ];
    expect(uniqueBy(rows, (r) => r.id)).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 1 },
    ]);
  });
});
