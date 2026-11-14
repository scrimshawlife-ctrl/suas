import { isApiError } from '../../api/errors';
import { NEEDS } from '../../components/needs';
import type { ChatThread } from '../../api/types';
import { formatAcceptedAt } from './messages';

/** Shown when a thread has no counterpart name (the other person never set one). */
export const UNNAMED = 'The other person';

export const EMPTY_THREADS = 'You have no conversations yet.';
export const SYSTEM_LINE = 'Chat is open for this request.';
export const CHECKING_LINE = 'Checking this chat…';
export const CLOSED_LINE = 'This helper released the request. This chat is closed.';

/** The opening line of a conversation: when it was accepted, if the thread says and who is asking. */
export function systemLine(thread: ChatThread | undefined, now: Date = new Date()): string {
  const when = thread?.accepted_at ? formatAcceptedAt(thread.accepted_at, now) : '';
  if (thread === undefined || when === '') return SYSTEM_LINE;
  if (thread.role === 'ACCEPTER') return `You accepted this request on ${when}. ${SYSTEM_LINE}`;
  const name = thread.counterpart_display_name?.trim();
  return name ? `${name} accepted your request on ${when}.` : SYSTEM_LINE;
}

export function counterpartName(thread: ChatThread | undefined): string {
  return thread?.counterpart_display_name?.trim() || UNNAMED;
}

/** The request's one-line summary, or its category label when it has none. */
export function threadTitle(thread: ChatThread): string {
  return thread.summary?.trim() || NEEDS[thread.category].label;
}

const NOT_ACCEPTED_YET = 'Chat opens once someone accepts your request.';
const NO_SUCH_CONVERSATION = "We couldn't find that conversation.";

/** Plain-words explanation for a failed conversation load. */
export function conversationErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'CHAT_UNAVAILABLE') return NOT_ACCEPTED_YET;
    if (error.status === 404) return NO_SUCH_CONVERSATION;
  }
  return "We couldn't load this conversation. Try again.";
}

/** A 409 or 404 will not change on retry, so it gets no "Try again". */
export function isPermanentConversationError(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.code === 'CHAT_UNAVAILABLE');
}

/**
 * A send the server refused for good: a 4xx other than 408 (timed out), 429 (too many tries) and
 * 409 IDEMPOTENCY_CONFLICT, which sending the same message again cannot fix. The outbox resends
 * with the same key and body, so that 409 only means the first try is still being stored
 * (`src/idempotency/run.ts`, CommandInProgressError: "Retry once the original request
 * settles"); the next try replays its answer.
 */
export function isFinalSendError(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429 &&
    error.code !== 'IDEMPOTENCY_CONFLICT'
  );
}

/** Why a final send failure happened, shown after "Could not send." */
export function sendRefusedText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'CHAT_CLOSED') return 'This chat is closed.';
    if (error.code === 'CHAT_UNAVAILABLE') return NOT_ACCEPTED_YET;
    if (error.status === 413) return 'The message is too long.';
    if (error.status === 404) return NO_SUCH_CONVERSATION;
    if (error.status === 403) return 'You can no longer send messages here.';
  }
  return 'The message was not accepted.';
}
