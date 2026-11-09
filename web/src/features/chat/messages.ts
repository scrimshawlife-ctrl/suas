import type { InfiniteData } from '@tanstack/react-query';
import type { Schemas } from '../../api/types';

export type ChatMessage = Schemas['ChatMessage'];

/** One REST page: messages arrive newest first, `next_cursor` points at older ones. */
export interface MessagePage {
  messages: ChatMessage[];
  next_cursor: string | null;
}

export type MessagesData = InfiniteData<MessagePage, string | undefined>;

/** Newest first: `created_at` is fixed-width ISO text, so string order is time order. */
function newestFirst(a: ChatMessage, b: ChatMessage): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  if (a.chat_message_id === b.chat_message_id) return 0;
  return a.chat_message_id < b.chat_message_id ? 1 : -1;
}

/** Every loaded message once, oldest to newest, for display. */
export function toOldestFirst(data: { pages: MessagePage[] } | undefined): ChatMessage[] {
  if (data === undefined) return [];
  const byId = new Map<string, ChatMessage>();
  for (const page of data.pages) {
    for (const message of page.messages) byId.set(message.chat_message_id, message);
  }
  return [...byId.values()].sort((a, b) => -newestFirst(a, b));
}

/**
 * Adds a message to the cached pages unless its `chat_message_id` is already there (a
 * push frame, a REST refetch and our own send can all deliver the same message). It goes
 * into the first page, which holds the newest messages; display order is re-derived from
 * the timestamps, so a late arrival still lands in the right place.
 */
export function insertMessage(data: MessagesData, message: ChatMessage): MessagesData {
  const known = data.pages.some((page) =>
    page.messages.some((m) => m.chat_message_id === message.chat_message_id),
  );
  if (known) return data;
  const [first, ...rest] = data.pages;
  if (first === undefined) return data;
  const firstPage: MessagePage = {
    ...first,
    messages: [message, ...first.messages].sort(newestFirst),
  };
  return { ...data, pages: [firstPage, ...rest] };
}

/** Outgoing or incoming: the sender is compared with the signed-in person. */
export function isMine(message: ChatMessage, meUserId: string | undefined): boolean {
  return meUserId !== undefined && message.sender_user_id === meUserId;
}

/** Ids of messages that end a run from one sender; the timestamp line goes under each. */
export function runEnds(messages: readonly ChatMessage[]): ReadonlySet<string> {
  const ends = new Set<string>();
  messages.forEach((message, index) => {
    const next = messages[index + 1];
    if (next?.sender_user_id !== message.sender_user_id) ends.add(message.chat_message_id);
  });
  return ends;
}

/** "Tue at 7:58 PM" within the last week; "Nov 3 at 7:58 PM" otherwise. Empty if not a date. */
export function formatAcceptedAt(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const ageMs = now.getTime() - date.getTime();
  const day =
    ageMs >= 0 && ageMs < 6 * 86_400_000
      ? date.toLocaleDateString(undefined, { weekday: 'short' })
      : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${day} at ${time}`;
}

/** "8:14 PM" today; "Tue 8:14 PM" within a week; "Nov 3, 8:14 PM" otherwise. Local time. */
export function formatMessageTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return time;
  if (days > 0 && days < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}
