/**
 * R18.7 (contributor proposal, not released): a suggested reply or catch-up summary for the helper.
 * It writes, stores and logs nothing; crisis language in the chat skips the model (as intake, R17.4).
 */

import { detectCrisisLanguage } from '../intake/crisis-check.js';
import {
  escapePromptData,
  INFERENCE_PURPOSE_LIMITS,
  type ModelInferencePort,
  type ModelMessagePart,
} from '../inference/index.js';
import { guardAssistText, type AssistGuardReport } from './assist-guard.js';
import { CHAT_ASSIST_SYSTEM_PROMPT } from './assist-prompt.js';

export const CHAT_ASSIST_KINDS = ['SUGGEST_REPLY', 'CATCH_UP'] as const;
export type ChatAssistKind = (typeof CHAT_ASSIST_KINDS)[number];

/** How many of the newest messages the model sees. */
export const CHAT_ASSIST_WINDOW = 30;
export const CHAT_ASSIST_TEMPERATURE = 0.2;
/** Per helper per hour; shared with the worker so it prunes the same window. */
export const CHAT_ASSIST_RATE_LIMIT = {
  bucket: 'chat.assist.hourly',
  limit: 20,
  windowSeconds: 3_600,
};
/** Character caps on the returned text, cut on a word boundary. */
export const CHAT_ASSIST_TEXT_MAX: Readonly<Record<ChatAssistKind, number>> = {
  SUGGEST_REPLY: 400,
  CATCH_UP: 600,
};

const TASK_LINES: Readonly<Record<ChatAssistKind, string>> = {
  SUGGEST_REPLY: "Task: SUGGEST_REPLY. Write the helper's next message to the Veteran.",
  CATCH_UP: 'Task: CATCH_UP. Write a short neutral summary of this chat for the helper.',
};

export interface ChatAssistRequestFields {
  readonly category: string;
  readonly summary: string | null;
  readonly timing: string | null;
  readonly meetingPlace: string | null;
  readonly destination: string | null;
}

export interface ChatAssistMessage {
  /** True for the helper's own messages, false for the Veteran's. */
  readonly fromHelper: boolean;
  readonly body: string;
}

export interface ChatAssistInput {
  readonly kind: ChatAssistKind;
  readonly request: ChatAssistRequestFields;
  /** Oldest first; only the last {@link CHAT_ASSIST_WINDOW} are used. */
  readonly messages: readonly ChatAssistMessage[];
}

/**
 * - `SUGGESTION` / `CATCH_UP`: `text` holds the answer for that kind.
 * - `CRISIS_SUPPORT`: the request or a message matched the crisis list; no model was asked.
 * - `UNAVAILABLE`: no model, a model failure, an empty answer, or one the output guard dropped.
 */
export interface ChatAssistResult {
  readonly outcome: 'SUGGESTION' | 'CATCH_UP' | 'CRISIS_SUPPORT' | 'UNAVAILABLE';
  readonly text?: string;
  /** Set whenever the model answered; for the eval only, never in an HTTP response. */
  readonly guard?: AssistGuardReport;
}

const UNAVAILABLE: ChatAssistResult = { outcome: 'UNAVAILABLE' };

/** Wrap untrusted text in a tag; escaping its angle brackets means it can forge no tag at all. */
function tagged(tag: string, text: string): string {
  return `<${tag}>\n${escapePromptData(text)}\n</${tag}>`;
}

/**
 * Request fields and each message are guarded parts, so the guardrail screens them (R17.5). The
 * "Veteran:" / "You:" label comes from the sender id, never from message text.
 */
function userParts(input: ChatAssistInput, window: readonly ChatAssistMessage[]) {
  const { category, summary, timing, meetingPlace, destination } = input.request;
  const fields = JSON.stringify({
    category,
    summary,
    timing,
    meeting_place: meetingPlace,
    destination,
  });
  const parts: ModelMessagePart[] = [
    { type: 'text', text: `Request details:\n${tagged('request', fields)}`, guarded: true },
    ...window.map((message): ModelMessagePart => ({
      type: 'text',
      text: `${message.fromHelper ? 'You' : 'Veteran'}:\n${tagged('message', message.body)}`,
      guarded: true,
    })),
    { type: 'text', text: TASK_LINES[input.kind] },
  ];
  return parts;
}

/** Drop reasoning blocks, including one the model never closed. */
function stripThinking(text: string): string {
  const closed = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = closed.search(/<think>/i);
  return open === -1 ? closed : closed.slice(0, open);
}

/** At most `max` characters, cut at the last space inside the cap when there is one. */
export function capOnWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.search(/\s\S*$/);
  return (space > 0 ? cut.slice(0, space) : cut).trimEnd();
}

export async function assistChat(
  port: ModelInferencePort,
  input: ChatAssistInput,
): Promise<ChatAssistResult> {
  const window = input.messages.slice(-CHAT_ASSIST_WINDOW);
  // R18.6 (contributor's call, D-066): every text the model would see, the helper's messages
  // too, since a helper may quote the Veteran ("Veteran said: I want to die").
  const { category, summary, timing, meetingPlace, destination } = input.request;
  const fields = [summary, timing, meetingPlace, destination].filter((text) => text !== null);
  const chatText = window.map((message) => message.body);
  if ([...fields, ...chatText].some((text) => detectCrisisLanguage(text))) {
    return { outcome: 'CRISIS_SUPPORT' };
  }
  if (!port.isAvailable()) return UNAVAILABLE;

  const limits = INFERENCE_PURPOSE_LIMITS.chat_assist;
  let result;
  try {
    result = await port.converse({
      system: CHAT_ASSIST_SYSTEM_PROMPT,
      messages: [{ role: 'user', parts: userParts(input, window) }],
      tools: [],
      purpose: 'chat_assist',
      deadlineMs: limits.callTimeoutCapMs,
      maxTokens: limits.maxTokens,
      temperature: CHAT_ASSIST_TEMPERATURE,
    });
  } catch {
    // Drop the error: its message could quote the chat.
    return UNAVAILABLE;
  }
  if (!result.ok) return UNAVAILABLE;

  const raw = stripThinking(result.text).trim();
  if (raw === '') return UNAVAILABLE;
  const { text: kept, ...guard } = guardAssistText(input.kind, raw, {
    source: [category, ...fields, ...chatText].join('\n'),
    helperText: window
      .filter((message) => message.fromHelper)
      .map((message) => message.body)
      .join('\n'),
  });
  const text = capOnWord(kept, CHAT_ASSIST_TEXT_MAX[input.kind]);
  if (text === '') return { ...UNAVAILABLE, guard };
  return { outcome: input.kind === 'SUGGEST_REPLY' ? 'SUGGESTION' : 'CATCH_UP', text, guard };
}
