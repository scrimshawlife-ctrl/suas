import { describe, expect, it } from 'vitest';
import type { ChatThread } from '../../api/types';
import { countUnread, createSeenStore } from './unread';

const thread = (id: string, at: string | null): ChatThread => ({
  service_request_id: id,
  category: 'FOOD',
  summary: null,
  counterpart_display_name: 'Ray K.',
  last_message_body: at === null ? null : 'hi',
  last_message_at: at,
  closed: false,
});

describe('unread count', () => {
  it('counts only threads with a message newer than the last one seen', () => {
    const store = createSeenStore();
    const base = store.getState().baseline;
    const later = new Date(base + 60_000).toISOString();
    const earlier = new Date(base - 60_000).toISOString();
    const threads = [
      thread('a', later),
      thread('b', earlier),
      thread('c', null),
      thread('d', later),
    ];
    expect(countUnread(threads, store.getState())).toBe(2);

    store.markSeen('a', base + 60_000);
    expect(countUnread(threads, store.getState())).toBe(1);

    store.markSeen('d', base + 30_000);
    expect(countUnread(threads, store.getState())).toBe(1);
  });
});
