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

/** Plain-words explanation for a failed conversation load. */
export function conversationErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'CHAT_UNAVAILABLE') return 'Chat opens once someone accepts your request.';
    if (error.status === 404) return "We couldn't find that conversation.";
  }
  return "We couldn't load this conversation. Try again.";
}

/** A 409 or 404 will not change on retry, so it gets no "Try again". */
export function isPermanentConversationError(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.code === 'CHAT_UNAVAILABLE');
}
