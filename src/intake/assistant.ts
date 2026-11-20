/**
 * Intake Assistant core: runs the tool-calling turns for one Veteran message.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 (Intake Assistant: exactly two model
 * tools, a draft the Veteran reviews, plain form if the model fails). AGENTS.md
 * rule 14: nothing here changes durable state. The result is a proposal; the
 * caller stores it as a draft and only the Veteran's submit creates a Service
 * Request.
 *
 * This module has no database or HTTP knowledge, so the F11 eval can run it
 * against any inference adapter. Intake text goes only to the inference port;
 * nothing here logs it.
 */

import {
  INFERENCE_PURPOSE_LIMITS,
  type ModelInferencePort,
  type ModelMessage,
  type ModelMessagePart,
  type ModelToolCall,
  type ModelFailureKind,
  type ModelTurnRequest,
  type ModelTurnResult,
} from '../inference/index.js';
import { detectCrisisLanguage } from './crisis-check.js';
import { INTAKE_SYSTEM_PROMPT } from './system-prompt.js';
import {
  draftServiceRequestInput,
  INTAKE_CATEGORIES,
  INTAKE_TOOL_NAMES,
  INTAKE_TOOLS,
  searchResourcesInput,
  type IntakeCategory,
  type IntakeToolName,
  type SearchResourcesInput,
} from './tools.js';

/** Upper bound on model calls per Veteran message (tool round trips included). */
export const MAX_MODEL_CALLS = 4;
export const MAX_ASSISTANT_TEXT = 1_500;
export const MAX_RESOURCES_PER_SEARCH = 5;

/**
 * Whole-run budget for one Veteran message, inside the 29 s HTTP API limit, and the least
 * time worth starting another call with (R17.3, contributor proposal, not released).
 */
export const INTAKE_RUN_DEADLINE_MS = 24_000;
export const MIN_CALL_BUDGET_MS = 3_000;

/** Shown when the Veteran asks for something outside the four categories. */
export const NOT_AVAILABLE_NOTICE =
  'SUAS cannot take requests for that need yet. Resources that may help are listed below.';
/** Used when tools ran but the model wrote no closing text. */
const DEFAULT_DRAFT_TEXT =
  'I drafted a request from what you wrote. Please check it before you submit.';

/**
 * A text-only reply that turns the need away without searching (R18.5, contributor proposal,
 * not released). The server then shows its notice and searches itself; a question does not match.
 */
const DECLINE_PATTERN =
  /\b(can ?not|can['’]t|cannot|not able to|unable to) (take|help with|accept)\b/i;

/** Veteran-facing projection of a published Resource (RESOURCES.md §6). */
export interface IntakeResource {
  readonly resourceId: string;
  readonly serviceName: string;
  readonly category: string;
  readonly counties: readonly string[];
  readonly hours: string | null;
  readonly cost: string | null;
  readonly contactMethod: string | null;
  readonly contactMethodKind: string | null;
  readonly contacts: readonly { readonly kind: string; readonly value: string }[];
  readonly area: string | null;
  readonly verifiedAt: string | null;
  readonly freshness: string;
  readonly staleWarning: boolean;
}

/** The one read the assistant may make. Implemented over the database, or in memory for the eval. */
export interface IntakeHost {
  searchResources(input: SearchResourcesInput): Promise<readonly IntakeResource[]>;
}

export interface IntakeDraftFields {
  readonly category: IntakeCategory | null;
  readonly summary: string | null;
  readonly timing: string | null;
  readonly meetingPlace: string | null;
  readonly destination: string | null;
}

export const EMPTY_DRAFT_FIELDS: IntakeDraftFields = {
  category: null,
  summary: null,
  timing: null,
  meetingPlace: null,
  destination: null,
};

/**
 * - `DRAFT_READY`: the draft has a category and summary for the Veteran to review.
 * - `NO_DRAFT`: the assistant asked a question or the need is not available yet.
 * - `FALLBACK_FORM`: the model did not answer; the client shows the plain form.
 * - `CRISIS_SUPPORT`: crisis language was found, so no model was asked; the client shows the
 *   released crisis copy beside the plain form (R17.4, contributor proposal, not released).
 */
export type IntakeOutcome = 'DRAFT_READY' | 'NO_DRAFT' | 'FALLBACK_FORM' | 'CRISIS_SUPPORT';

export interface IntakeRunInput {
  /** Everything the Veteran has typed so far, oldest first. */
  readonly intakeText: string;
  /** The draft as it stands before this message. */
  readonly draft: IntakeDraftFields;
}

export interface IntakeRun {
  readonly outcome: IntakeOutcome;
  readonly assistantText: string;
  readonly draft: IntakeDraftFields;
  /** Resources returned by search_resources, in the order found, without repeats. */
  readonly resources: readonly IntakeResource[];
  /** The Veteran asked for a need outside the four categories. */
  readonly notAvailableYet: boolean;
  /** Tool calls refused because the tool is not one of the two. */
  readonly refusedToolCalls: number;
  readonly failure?: ModelFailureKind;
}

/** Wrap the Veteran's words so the model reads them as data, not instructions. */
function renderUserMessage(input: IntakeRunInput): string {
  const safeText = input.intakeText.replaceAll('</intake_text>', '');
  const current =
    input.draft.category === null
      ? 'No draft yet.'
      : JSON.stringify({
          category: input.draft.category,
          summary: input.draft.summary,
          timing: input.draft.timing,
          meeting_place: input.draft.meetingPlace,
          destination: input.draft.destination,
        });
  return `<intake_text>\n${safeText}\n</intake_text>\n\nCurrent draft: ${current}`;
}

function isToolName(name: string): name is IntakeToolName {
  return (INTAKE_TOOL_NAMES as readonly string[]).includes(name);
}

/** "food" and "Peer support" are the right category written loosely, not another need. */
function normalizeCategory(value: unknown): unknown {
  return typeof value === 'string'
    ? value
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_')
    : value;
}

interface RunState {
  draft: IntakeDraftFields;
  resources: Map<string, IntakeResource>;
  notAvailableYet: boolean;
  refusedToolCalls: number;
  searched: boolean;
}

interface ToolOutcome {
  readonly content: string;
  readonly isError?: boolean;
}

function error(content: string): ToolOutcome {
  return { content, isError: true };
}

async function runSearch(
  call: ModelToolCall,
  host: IntakeHost,
  state: RunState,
): Promise<ToolOutcome> {
  state.searched = true;
  const parsed = searchResourcesInput.safeParse(call.input);
  if (!parsed.success) {
    return error('Invalid input. Use only category, keywords and outside_categories.');
  }
  if (parsed.data.outside_categories === true) state.notAvailableYet = true;
  let found: readonly IntakeResource[];
  try {
    found = await host.searchResources(parsed.data);
  } catch {
    return error('Resource search is unavailable right now.');
  }
  const top = found.slice(0, MAX_RESOURCES_PER_SEARCH);
  for (const resource of top) state.resources.set(resource.resourceId, resource);
  return {
    content: JSON.stringify({
      resources: top.map((resource) => ({
        resource_id: resource.resourceId,
        service_name: resource.serviceName,
        category: resource.category,
        counties: resource.counties,
        hours: resource.hours,
        cost: resource.cost,
      })),
    }),
  };
}

function runDraft(call: ModelToolCall, state: RunState): ToolOutcome {
  const raw = call.input;
  const input =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  if ('category' in input) input.category = normalizeCategory(input.category);

  const category = input.category;
  const named = typeof category === 'string' && category !== '';
  if (named && !(INTAKE_CATEGORIES as readonly string[]).includes(category)) {
    // A real need SUAS does not serve yet. Nothing is drafted for it.
    state.notAvailableYet = true;
    return error(
      `SUAS cannot take requests for this need yet. Do not draft it. Tell the Veteran plainly it ` +
        `is not available yet and call search_resources. Allowed categories: ${INTAKE_CATEGORIES.join(', ')}.`,
    );
  }

  const parsed = draftServiceRequestInput.safeParse(input);
  if (!parsed.success) {
    return error(
      'Invalid input. Provide category and summary; timing, meeting_place and destination are optional.',
    );
  }
  if (parsed.data.destination !== undefined && parsed.data.category !== 'TRANSPORTATION') {
    return error('destination is only for TRANSPORTATION requests. Leave it out.');
  }
  state.draft = {
    category: parsed.data.category,
    summary: parsed.data.summary,
    timing: parsed.data.timing ?? null,
    meetingPlace: parsed.data.meeting_place ?? null,
    destination: parsed.data.destination ?? null,
  };
  return { content: 'Draft saved. The Veteran will review it before submitting.' };
}

async function runTool(
  call: ModelToolCall,
  host: IntakeHost,
  state: RunState,
): Promise<ToolOutcome> {
  if (!isToolName(call.name)) {
    // The contract is two tools. Anything else is refused and never executed.
    state.refusedToolCalls += 1;
    return error('That tool is not available.');
  }
  return call.name === 'search_resources' ? runSearch(call, host, state) : runDraft(call, state);
}

/**
 * The model declined an outside need in words but skipped the search the prompt asks for:
 * run that search server-side so the notice and Resources still come from SUAS, not the model.
 */
async function backstopDecline(text: string, host: IntakeHost, state: RunState): Promise<void> {
  const draftReady = state.draft.category !== null && state.draft.summary !== null;
  if (draftReady || state.notAvailableYet || state.searched || !DECLINE_PATTERN.test(text)) return;
  const call = {
    id: 'server-search',
    name: 'search_resources',
    input: { outside_categories: true },
  };
  await runSearch(call, host, state);
}

function finish(state: RunState, assistantText: string, failure?: ModelFailureKind): IntakeRun {
  const draftReady = state.draft.category !== null && state.draft.summary !== null;
  const outcome: IntakeOutcome =
    failure !== undefined ? 'FALLBACK_FORM' : draftReady ? 'DRAFT_READY' : 'NO_DRAFT';
  return {
    outcome,
    assistantText: assistantText.trim().slice(0, MAX_ASSISTANT_TEXT),
    draft: state.draft,
    resources: [...state.resources.values()],
    notAvailableYet: state.notAvailableYet,
    refusedToolCalls: state.refusedToolCalls,
    ...(failure !== undefined ? { failure } : {}),
  };
}

/** The port's answer, or `timeout` once the run's remaining time is spent, whichever is first. */
async function converseWithin(
  port: ModelInferencePort,
  request: ModelTurnRequest,
  remainingMs: number,
): Promise<ModelTurnResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<ModelTurnResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, failure: 'timeout' }), remainingMs);
  });
  try {
    return await Promise.race([port.converse(request), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runIntakeAssistant(
  port: ModelInferencePort,
  host: IntakeHost,
  input: IntakeRunInput,
): Promise<IntakeRun> {
  const state: RunState = {
    draft: input.draft,
    resources: new Map(),
    notAvailableYet: false,
    refusedToolCalls: 0,
    searched: false,
  };
  // Before any model call, and whether or not a model is configured (R17.4, proposal). It
  // covers every Veteran-written text the model would see: the typed text and the draft fields.
  const { summary, timing, meetingPlace, destination } = input.draft;
  const sentToModel = [input.intakeText, summary, timing, meetingPlace, destination];
  if (sentToModel.some((text) => text !== null && detectCrisisLanguage(text))) {
    return { ...finish(state, ''), outcome: 'CRISIS_SUPPORT' };
  }
  if (!port.isAvailable()) return finish(state, '', 'unavailable');

  // The Veteran's words are the untrusted part the guardrail screens (R17.5, proposal).
  const messages: ModelMessage[] = [
    { role: 'user', parts: [{ type: 'text', text: renderUserMessage(input), guarded: true }] },
  ];

  const startedAt = Date.now();
  for (let call = 0; call < MAX_MODEL_CALLS; call += 1) {
    const remainingMs = INTAKE_RUN_DEADLINE_MS - (Date.now() - startedAt);
    if (remainingMs < MIN_CALL_BUDGET_MS) return finish(state, '', 'timeout');
    let result;
    try {
      result = await converseWithin(
        port,
        {
          system: INTAKE_SYSTEM_PROMPT,
          messages,
          tools: INTAKE_TOOLS,
          purpose: 'intake',
          deadlineMs: remainingMs,
          maxTokens: INFERENCE_PURPOSE_LIMITS.intake.maxTokens,
        },
        remainingMs,
      );
    } catch {
      // The port should not throw. If it does, drop the error: its message could
      // quote the request, and intake text must never reach a log.
      return finish(state, '', 'unavailable');
    }
    if (!result.ok) return finish(state, '', result.failure);

    if (result.toolCalls.length === 0) {
      await backstopDecline(result.text, host, state);
      return finish(state, result.text);
    }

    const assistantParts: ModelMessagePart[] = [];
    if (result.text !== '') assistantParts.push({ type: 'text', text: result.text });
    const resultParts: ModelMessagePart[] = [];
    for (const toolCall of result.toolCalls) {
      assistantParts.push({ type: 'tool_call', call: toolCall });
      const outcome = await runTool(toolCall, host, state);
      resultParts.push({
        type: 'tool_result',
        callId: toolCall.id,
        content: outcome.content,
        ...(outcome.isError === true ? { isError: true } : {}),
      });
    }
    messages.push({ role: 'assistant', parts: assistantParts });
    messages.push({ role: 'user', parts: resultParts });
  }

  // Out of calls while the model was still using tools. Keep what the tools produced.
  const draftReady = state.draft.category !== null && state.draft.summary !== null;
  if (!draftReady && !state.notAvailableYet) return finish(state, '', 'invalid');
  return finish(state, draftReady ? DEFAULT_DRAFT_TEXT : '');
}
