import type { ChatThread } from '../../api/types';
import { paths } from '../../app/paths';

/** The query parameter that names one thread of a request, as in `?thread=<chat_thread_id>`. */
export const THREAD_PARAM = 'thread';

/** A release closed the thread: it can be read but not written to. */
export function isReadOnly(thread: ChatThread | undefined): boolean {
  return typeof thread?.closed_at === 'string';
}

/** One request can have several threads, so the thread id (when sent) identifies a row. */
export function threadKey(thread: ChatThread): string {
  return thread.chat_thread_id ?? thread.service_request_id;
}

/** A live thread opens at the request's own chat path; a closed one names itself. */
export function threadHref(thread: ChatThread): string {
  const base = paths.chatThread(thread.service_request_id);
  return isReadOnly(thread) && thread.chat_thread_id !== undefined
    ? `${base}?${THREAD_PARAM}=${thread.chat_thread_id}`
    : base;
}

/**
 * The thread on screen: the one the address names, else the request's live thread, else its
 * newest (the list is newest first), which is the closed one when nobody has re-accepted.
 */
export function pickThread(
  threads: readonly ChatThread[] | undefined,
  serviceRequestId: string | undefined,
  threadId: string | null,
): ChatThread | undefined {
  const ofRequest = threads?.filter((t) => t.service_request_id === serviceRequestId) ?? [];
  if (threadId !== null) return ofRequest.find((t) => t.chat_thread_id === threadId);
  return ofRequest.find((t) => !isReadOnly(t)) ?? ofRequest[0];
}
