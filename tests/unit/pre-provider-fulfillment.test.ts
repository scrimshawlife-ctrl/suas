/**
 * The stop before a provider API.
 *
 * SUAS-specs WAVE_C_CONSERVATIVE_DEFAULTS.md C1: no command writes PARTIAL,
 * a dispute never returns to CONFIRMED, and fulfillment FAILED does not by
 * itself mark the request UNFULFILLABLE.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NON_CONFIRMABLE_FULFILLMENT_STATES } from '../../src/fulfillment/attempts.js';

const fulfillmentDir = fileURLToPath(new URL('../../src/fulfillment/', import.meta.url));

function fulfillmentSources(): { readonly name: string; readonly text: string }[] {
  return readdirSync(fulfillmentDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({
      name,
      text: readFileSync(join(fulfillmentDir, name), 'utf8'),
    }));
}

describe('pre-provider fulfillment stop', () => {
  it('does not write PARTIAL or call MARK_UNFULFILLABLE from fulfillment', () => {
    for (const source of fulfillmentSources()) {
      expect(source.text, source.name).not.toMatch(/state:\s*'PARTIAL'/);
      expect(source.text, source.name).not.toContain('MARK_UNFULFILLABLE');
    }
  });

  it('records provider acceptance only as fulfillment ACCEPTED', () => {
    const router = fulfillmentSources().find((source) => source.name === 'router.ts');
    expect(router).toBeDefined();
    const states = [...router!.text.matchAll(/state:\s*'([A-Z_]+)'/g)].map((match) => match[1]);
    expect(states).toEqual(['ACCEPTED']);
  });

  it('refuses confirmation after dispute, cancellation, or failure', () => {
    expect([...NON_CONFIRMABLE_FULFILLMENT_STATES].sort()).toEqual([
      'CANCELLED',
      'DISPUTED',
      'FAILED',
    ]);
  });
});
