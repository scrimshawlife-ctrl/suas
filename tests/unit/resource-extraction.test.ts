/**
 * Catalog builder extraction (no database): the model's answer is accepted only when
 * it is exactly one valid tool call, and the source link and pasted text reach the model
 * as data. V1_PROJECT_PLAN.md §2.1 "Catalog builder".
 */

import { describe, expect, it } from 'vitest';
import { extractResourceDrafts, RESOURCE_EXTRACTION_TOOL } from '../../src/catalog/index.js';
import {
  ScriptedModelInference,
  UnavailableModelInference,
  type ModelTurnResult,
} from '../../src/inference/index.js';

const input = {
  sourceText: 'Valley Pantry, Santa Clara County. Free food Mon-Fri 9-5. Call 408-555-0100.',
  sourceLink: 'https://example.invalid/valley-pantry',
};

function toolCall(payload: unknown, name = RESOURCE_EXTRACTION_TOOL): ModelTurnResult {
  return { ok: true, text: '', toolCalls: [{ id: 'call-1', name, input: payload }] };
}

const validResource = {
  service_name: 'Valley Pantry',
  category: 'FOOD',
  counties: ['SANTA_CLARA'],
  hours: 'Mon-Fri 9-5',
  contact_method: '408-555-0100',
  contact_method_kind: 'PHONE',
};

describe('extractResourceDrafts', () => {
  it('returns the validated resources from one tool call', async () => {
    const port = new ScriptedModelInference().enqueue(toolCall({ resources: [validResource] }));
    const result = await extractResourceDrafts(port, input);
    expect(result).toEqual({ ok: true, resources: [validResource] });
  });

  it('keeps up to three contacts and an area, and offers the model the list', async () => {
    const withContacts = {
      service_name: 'Valley Pantry',
      category: 'FOOD',
      counties: ['SANTA_CLARA'],
      contacts: [
        { kind: 'PHONE', value: '408-555-0100' },
        { kind: 'URL', value: 'https://valley.example.invalid' },
        { kind: 'EMAIL', value: 'help@valley.example.invalid' },
      ],
      area: 'San Jose, east side',
    };
    const port = new ScriptedModelInference().enqueue(toolCall({ resources: [withContacts] }));
    expect(await extractResourceDrafts(port, input)).toEqual({
      ok: true,
      resources: [withContacts],
    });
    const schema = JSON.stringify(port.requests()[0]?.tools[0]?.inputSchema);
    expect(schema).toContain('"contacts"');
    expect(schema).toContain('"area"');
  });

  it('accepts an empty list: a source with no usable resource yields zero drafts', async () => {
    const port = new ScriptedModelInference().enqueue(toolCall({ resources: [] }));
    expect(await extractResourceDrafts(port, input)).toEqual({ ok: true, resources: [] });
  });

  it('sends the pasted text as data and the only tool is the extraction tool', async () => {
    const port = new ScriptedModelInference().enqueue(toolCall({ resources: [] }));
    await extractResourceDrafts(port, input);
    const [request] = port.requests();
    expect(request?.tools.map((tool) => tool.name)).toEqual([RESOURCE_EXTRACTION_TOOL]);
    const text = JSON.stringify(request?.messages);
    expect(text).toContain(input.sourceLink);
    expect(text).toContain('Valley Pantry');
  });

  it.each([
    ['an unknown category', { resources: [{ ...validResource, category: 'LEGAL' }] }],
    [
      'a county outside the launch list',
      { resources: [{ ...validResource, counties: ['MARIN'] }] },
    ],
    [
      'a verification field the model must never set',
      { resources: [{ ...validResource, last_verified_at: '2026-01-01' }] },
    ],
    [
      'a contact kind without a contact method',
      {
        resources: [
          { service_name: 'X', category: 'FOOD', counties: [], contact_method_kind: 'PHONE' },
        ],
      },
    ],
    [
      'a 988 contact',
      { resources: [{ ...validResource, contacts: [{ kind: 'PHONE', value: '988' }] }] },
    ],
    [
      'an sms:838255 contact',
      {
        resources: [{ ...validResource, contacts: [{ kind: 'FREEFORM', value: 'sms:838255' }] }],
      },
    ],
    [
      'a fourth contact',
      {
        resources: [
          {
            ...validResource,
            contacts: ['1', '2', '3', '4'].map((n) => ({
              kind: 'PHONE',
              value: `408-555-010${n}`,
            })),
          },
        ],
      },
    ],
    ['an area over 80 characters', { resources: [{ ...validResource, area: 'x'.repeat(81) }] }],
    ['a missing service name', { resources: [{ category: 'FOOD', counties: [] }] }],
    ['a payload that is not an object', 'resources'],
  ])('rejects %s as invalid_output', async (_label, payload) => {
    const port = new ScriptedModelInference().enqueue(toolCall(payload));
    expect(await extractResourceDrafts(port, input)).toEqual({
      ok: false,
      failure: 'invalid_output',
    });
  });

  it('rejects text with no tool call, a wrong tool, or several calls', async () => {
    const port = new ScriptedModelInference().enqueue(
      { ok: true, text: 'Here are the resources...', toolCalls: [] },
      toolCall({ resources: [] }, 'something_else'),
      {
        ok: true,
        text: '',
        toolCalls: [
          { id: 'a', name: RESOURCE_EXTRACTION_TOOL, input: { resources: [] } },
          { id: 'b', name: RESOURCE_EXTRACTION_TOOL, input: { resources: [] } },
        ],
      },
    );
    for (let i = 0; i < 3; i += 1) {
      expect(await extractResourceDrafts(port, input)).toEqual({
        ok: false,
        failure: 'invalid_output',
      });
    }
  });

  it('passes port failures through as typed failures', async () => {
    const port = new ScriptedModelInference().enqueue(
      { ok: false, failure: 'timeout' },
      { ok: false, failure: 'refused' },
    );
    expect(await extractResourceDrafts(port, input)).toEqual({ ok: false, failure: 'timeout' });
    expect(await extractResourceDrafts(port, input)).toEqual({ ok: false, failure: 'refused' });
  });

  it('reports unavailable without calling a model when the port is not configured', async () => {
    expect(await extractResourceDrafts(new UnavailableModelInference(), input)).toEqual({
      ok: false,
      failure: 'unavailable',
    });
  });
});
