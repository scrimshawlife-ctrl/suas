/**
 * Intake Assistant core: the two-tool contract, out-of-scope handling and the
 * fallback on port failure (V1_PROJECT_PLAN.md §2.1). No database, no network.
 */

import { describe, expect, it } from 'vitest';
import { ScriptedModelInference, MODEL_FAILURE_KINDS } from '../../src/inference/index.js';
import type {
  ModelInferencePort,
  ModelToolCall,
  ModelTurnResult,
} from '../../src/inference/index.js';
import {
  EMPTY_DRAFT_FIELDS,
  MAX_MODEL_CALLS,
  runIntakeAssistant,
  type IntakeHost,
  type IntakeResource,
} from '../../src/intake/assistant.js';
import { INTAKE_TOOLS } from '../../src/intake/tools.js';

const RESOURCE: IntakeResource = {
  resourceId: '11111111-1111-4111-8111-111111111111',
  serviceName: 'Example Job Help',
  category: 'PEER_SUPPORT',
  counties: [],
  hours: null,
  cost: null,
  contactMethod: null,
  contactMethodKind: null,
  contacts: [],
  area: null,
  verifiedAt: null,
  freshness: 'FRESH',
  staleWarning: false,
};

function host(): IntakeHost & { searches: unknown[] } {
  const searches: unknown[] = [];
  return {
    searches,
    searchResources(input) {
      searches.push(input);
      return Promise.resolve([RESOURCE]);
    },
  };
}

const calls = (...toolCalls: ModelToolCall[]): ModelTurnResult => ({
  ok: true,
  text: '',
  toolCalls,
});
const say = (text: string): ModelTurnResult => ({ ok: true, text, toolCalls: [] });
const draftCall = (input: unknown): ModelToolCall => ({
  id: 'c1',
  name: 'draft_service_request',
  input,
});

const run = (port: ModelInferencePort, h: IntakeHost = host()) =>
  runIntakeAssistant(port, h, {
    intakeText: 'I need groceries by Friday.',
    draft: EMPTY_DRAFT_FIELDS,
  });

describe('the two-tool contract', () => {
  it('offers the model exactly search_resources and draft_service_request', async () => {
    const port = new ScriptedModelInference().enqueue(say('What do you need?'));
    await run(port);
    const offered = port.requests()[0]?.tools.map((tool) => tool.name);
    expect(offered).toEqual(['search_resources', 'draft_service_request']);
    expect(INTAKE_TOOLS).toHaveLength(2);
  });

  it('refuses any other tool and never runs it', async () => {
    const h = host();
    const port = new ScriptedModelInference().enqueue(
      calls({ id: 'x1', name: 'send_email', input: { to: 'someone@example.invalid' } }),
      say('Done.'),
    );
    const result = await run(port, h);
    expect(result.refusedToolCalls).toBe(1);
    expect(result.draft).toEqual(EMPTY_DRAFT_FIELDS);
    expect(h.searches).toHaveLength(0);
    const second = port.requests()[1]?.messages.at(-1)?.parts[0];
    expect(second).toMatchObject({ type: 'tool_result', callId: 'x1', isError: true });
  });

  it('keeps a draft only for the four categories', async () => {
    const port = new ScriptedModelInference().enqueue(
      calls(draftCall({ category: 'FOOD', summary: 'Groceries', timing: 'Friday' })),
      say('I drafted it.'),
    );
    const result = await run(port);
    expect(result.outcome).toBe('DRAFT_READY');
    expect(result.draft).toEqual({
      category: 'FOOD',
      summary: 'Groceries',
      timing: 'Friday',
      meetingPlace: null,
      destination: null,
    });
  });

  it('accepts a loosely written category and rejects extra fields', async () => {
    const loose = await run(
      new ScriptedModelInference().enqueue(
        calls(draftCall({ category: 'peer support', summary: 'Someone to talk to' })),
        say('Drafted.'),
      ),
    );
    expect(loose.draft.category).toBe('PEER_SUPPORT');

    const extra = await run(
      new ScriptedModelInference().enqueue(
        calls(draftCall({ category: 'FOOD', summary: 'Groceries', submit: true })),
        say('Drafted.'),
      ),
    );
    expect(extra.draft).toEqual(EMPTY_DRAFT_FIELDS);
    expect(extra.outcome).toBe('NO_DRAFT');
  });
});

describe('needs outside the four categories', () => {
  it('drafts nothing for an out-of-scope category and says not available yet', async () => {
    const result = await run(
      new ScriptedModelInference().enqueue(
        calls(draftCall({ category: 'EMPLOYMENT', summary: 'A job' })),
        say('SUAS cannot do that yet.'),
      ),
    );
    expect(result.draft).toEqual(EMPTY_DRAFT_FIELDS);
    expect(result.outcome).toBe('NO_DRAFT');
    expect(result.notAvailableYet).toBe(true);
  });

  it('lists the Resources found when the model searches for an outside need', async () => {
    const result = await run(
      new ScriptedModelInference().enqueue(
        calls({
          id: 's1',
          name: 'search_resources',
          input: { keywords: 'job', outside_categories: true },
        }),
        say('Not available yet. These may help.'),
      ),
    );
    expect(result.notAvailableYet).toBe(true);
    expect(result.resources).toEqual([RESOURCE]);
    expect(result.draft).toEqual(EMPTY_DRAFT_FIELDS);
  });
});

describe('fallback to the plain form', () => {
  it.each(MODEL_FAILURE_KINDS)(
    'returns FALLBACK_FORM when the port fails with %s',
    async (failure) => {
      const result = await run(new ScriptedModelInference().enqueue({ ok: false, failure }));
      expect(result.outcome).toBe('FALLBACK_FORM');
      expect(result.failure).toBe(failure);
    },
  );

  it('returns FALLBACK_FORM when the port is unavailable', async () => {
    const result = await run({
      implementation: 'unavailable',
      isAvailable: () => false,
      converse: () => Promise.reject(new Error('never called')),
    });
    expect(result.outcome).toBe('FALLBACK_FORM');
  });

  it('returns FALLBACK_FORM, without leaking the error, when the port throws', async () => {
    const result = await run({
      implementation: 'broken',
      isAvailable: () => true,
      converse: () => Promise.reject(new Error('provider echoed: I need groceries')),
    });
    expect(result.outcome).toBe('FALLBACK_FORM');
    expect(JSON.stringify(result)).not.toContain('groceries');
  });

  it('stops after the call limit and falls back when no draft came out', async () => {
    const forever = new ScriptedModelInference();
    for (let i = 0; i < MAX_MODEL_CALLS + 2; i += 1) {
      forever.enqueue(calls({ id: `s${i}`, name: 'search_resources', input: {} }));
    }
    const result = await run(forever);
    expect(forever.requests()).toHaveLength(MAX_MODEL_CALLS);
    expect(result.outcome).toBe('FALLBACK_FORM');
  });
});
