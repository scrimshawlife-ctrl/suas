/**
 * Settlement reads are oneOf Settlement | VeteranSettlement in the committed
 * OpenAPI document. The payloads are the route serializers, not a copied schema.
 */

import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { publicSettlement } from '../../src/http/routes/cases.js';
import { veteranVisibleSettlement, type Settlement } from '../../src/settlement/settlements.js';

const document = JSON.parse(
  readFileSync(new URL('../../docs/openapi/v0.json', import.meta.url), 'utf8'),
) as {
  paths: Record<
    string,
    {
      get?: {
        responses: Record<string, { content?: { 'application/json'?: { schema: object } } }>;
      };
    }
  >;
  components: {
    schemas: Record<string, { required?: string[]; additionalProperties?: boolean } & object>;
  };
};

const settlement: Settlement = {
  settlementId: '11111111-1111-4111-8111-111111111111',
  tenantId: '55555555-5555-4555-8555-555555555555',
  caseId: '22222222-2222-4222-8222-222222222222',
  resolutionCycle: 1,
  requestedSummary: { item: 'food' },
  occurredSummary: { note: 'internal' },
  fulfilledSummary: {},
  unresolvedSummary: {},
  remainingFollowUps: [],
  authoredBy: '33333333-3333-4333-8333-333333333333',
  acceptedByUserId: '44444444-4444-4444-8444-444444444444',
  veteranConfirmedBy: undefined,
  settledAt: new Date('2026-11-06T00:00:00.000Z'),
};

function validatorFor(schema: object): (value: unknown) => boolean {
  const ajv = new Ajv({ allErrors: true });
  ajv.addFormat(
    'uuid',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);
  for (const [name, component] of Object.entries(document.components.schemas)) {
    ajv.addSchema(component, `#/components/schemas/${name}`);
  }
  const validate = ajv.compile(schema);
  return (value) => validate(value) === true;
}

describe('OpenAPI settlement oneOf', () => {
  it('validates the route serializers against the committed response schema', () => {
    const responseSchema =
      document.paths['/api/v0/cases/{id}/settlements/{settlement_id}']?.get?.responses['200']
        ?.content?.['application/json']?.schema;
    expect(responseSchema).toBeDefined();
    const full = publicSettlement(settlement);
    const veteran = veteranVisibleSettlement(settlement);
    const veteranSchema = document.components.schemas.VeteranSettlement;
    const fullSchema = document.components.schemas.Settlement;
    expect(veteranSchema?.additionalProperties).toBe(false);
    expect(veteranSchema?.required).toHaveLength(7);
    expect(Object.keys(veteran).sort()).toEqual([...(veteranSchema?.required ?? [])].sort());
    expect(Object.keys(full).sort()).toEqual([...(fullSchema?.required ?? [])].sort());

    const matchesResponse = validatorFor(responseSchema as object);
    const matchesVeteran = validatorFor(veteranSchema as object);
    const matchesFull = validatorFor(fullSchema as object);
    expect(matchesResponse(full)).toBe(true);
    expect(matchesResponse(veteran)).toBe(true);
    expect(matchesFull(full)).toBe(true);
    expect(matchesVeteran(full)).toBe(false);
    expect(matchesVeteran(veteran)).toBe(true);
    expect(matchesFull(veteran)).toBe(false);
  });
});
