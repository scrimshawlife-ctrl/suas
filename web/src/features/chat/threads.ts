import type { ChatThread } from '../../api/types';
import { paths } from '../../app/paths';

/** The query parameter that names one thread of a request, as in `?thread=<chat_thread_id>`. */
export const THREAD_PARAM = 'thread';

/** A release ended the thread (`released_at` set): it can be read but not written to. */
export function isReadOnly(thread: ChatThread | undefined): boolean {
  return typeof thread?.released_at === 'string';
}

/** One request can have several threads, so the thread id (when sent) identifies a row. */
export function threadKey(thread: ChatThread): string {
  return thread.chat_thread_id ?? thread.service_request_id;
}

/**
 * Every loaded page of the thread list as one list. The list is ordered by activity, so a
 * thread that moved between page reads can arrive twice; the first (newest) copy wins.
 */
export function allThreads(
  data: { pages: readonly { threads: readonly ChatThread[] }[] } | undefined,
): ChatThread[] | undefined {
  if (data === undefined) return undefined;
  const seen = new Set<string>();
  return data.pages
    .flatMap((page) => page.threads)
    .filter((thread) => {
      const key = threadKey(thread);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
