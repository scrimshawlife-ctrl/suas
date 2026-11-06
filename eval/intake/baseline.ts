/**
 * Keyword baseline that stands in for a model when the scripted fake is the
 * configured adapter. It follows the same tool contract as the real assistant
 * (search_resources, draft_service_request) so the harness, the tool loop and the
 * scoring all run in CI. It is deliberately simple and is not a quality claim.
 */

import type {
  ModelToolCall,
  ModelTurnRequest,
  ModelTurnResult,
  ScriptedTurn,
} from '../../src/inference/index.js';
import type { IntakeCategory } from '../../src/intake/tools.js';

const CATEGORY_WORDS: readonly (readonly [IntakeCategory, readonly string[]])[] = [
  ['FOOD', ['food', 'groceries', 'hungry', 'meal', 'eat', 'pantry']],
  ['TRANSPORTATION', ['ride', 'bus', 'transportation', 'drive me', 'drive']],
  ['SHELTER', ['shelter', 'place to stay', 'nowhere to stay', 'sleeping in my']],
  ['PEER_SUPPORT', ['talk', 'another veteran', 'fellow veteran', 'who served']],
];
const OUTSIDE_WORDS = ['job', 'resume', 'lawyer', 'legal', 'dentist', 'benefits claim'];
const TIMING_WORDS = [
  'tonight',
  'tomorrow',
  'this week',
  'this weekend',
  'weekend',
  'friday',
  'saturday',
  'sunday',
];

function intakeTextOf(request: ModelTurnRequest): string {
  const first = request.messages[0]?.parts[0];
  const raw = first?.type === 'text' ? first.text : '';
  return (/<intake_text>\n([\s\S]*?)\n<\/intake_text>/.exec(raw)?.[1] ?? '').toLowerCase();
}

function respond(request: ModelTurnRequest): ModelTurnResult {
  const last = request.messages[request.messages.length - 1];
  if (last?.parts.some((part) => part.type === 'tool_result') === true) {
    return {
      ok: true,
      text: 'I drafted a request. Please check it before you submit.',
      toolCalls: [],
    };
  }
  const text = intakeTextOf(request);
  const category = CATEGORY_WORDS.find(([, words]) =>
    words.some((word) => text.includes(word)),
  )?.[0];
  const outside = OUTSIDE_WORDS.find((word) => text.includes(word));
  const calls: ModelToolCall[] = [];
  if (category !== undefined) {
    const timing = TIMING_WORDS.find((word) => text.includes(word));
    calls.push({
      id: 'draft-1',
      name: 'draft_service_request',
      input: {
        category,
        summary: text.slice(0, 200),
        ...(timing !== undefined ? { timing } : {}),
      },
    });
  }
  if (outside !== undefined) {
    calls.push({
      id: 'search-1',
      name: 'search_resources',
      input: { keywords: outside, outside_categories: true },
    });
  }
  if (calls.length === 0) {
    return { ok: true, text: 'Can you tell me a little more about what you need?', toolCalls: [] };
  }
  return { ok: true, text: '', toolCalls: calls };
}

/** Two answers cover every path: tool calls, then closing text. */
export function baselineTurns(): readonly ScriptedTurn[] {
  return [respond, respond];
}
