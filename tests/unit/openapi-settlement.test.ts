/**
 * Settlement responses are oneOf Settlement | VeteranSettlement.
 * The full accepter payload must match exactly one of those schemas.
 */

import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const document = JSON.parse(
  readFileSync(new URL('../../docs/openapi/v0.json', import.meta.url), 'utf8'),
) as {
  components: { schemas: Record<string, object> };
};

function matchesExactlyOne(value: unknown): boolean {
  const ajv = new Ajv({ allErrors: true, unknownFormats: 'ignore' });
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }
  const validate = ajv.compile({
    oneOf: [
      { $ref: '#/components/schemas/Settlement' },
      { $ref: '#/components/schemas/VeteranSettlement' },
    ],
  });
  return validate(value) === true;
}

const full = {
  settlement_id: '11111111-1111-4111-8111-111111111111',
  case_id: '22222222-2222-4222-8222-222222222222',
  resolution_cycle: 1,
  requested: {},
  occurred: {},
  fulfilled: {},
  unresolved: {},
  remaining_follow_ups: [],
  authored_by: '33333333-3333-4333-8333-333333333333',
  accepted_by_user_id: '44444444-4444-4444-8444-444444444444',
  veteran_confirmed_by: null,
  settled_at: '2026-11-06T00:00:00.000Z',
};

const veteran = {
  settlement_id: full.settlement_id,
  resolution_cycle: 1,
  requested: {},
  fulfilled: {},
  unresolved: {},
  remaining_follow_ups: [],
  settled_at: full.settled_at,
};

describe('OpenAPI settlement oneOf', () => {
  it('accepts the accepter payload and the veteran payload as exactly one schema each', () => {
    expect(matchesExactlyOne(full)).toBe(true);
    expect(matchesExactlyOne(veteran)).toBe(true);
  });
});
