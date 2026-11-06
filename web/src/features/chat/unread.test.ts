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

  it('treats a message seen at microsecond precision as seen, against the thread millisecond time', () => {
    const store = createSeenStore();
    const micro = '2026-11-04T20:00:00.123456Z';
    const base = Date.parse(micro) - 60_000;
    // The thread list carries millisecond times; the opened message carried microseconds.
    const threads = [thread('a', '2026-11-04T20:00:00.123Z'), thread('b', micro)];
    store.markSeen('seed', base);
    const state = { baseline: base, seen: store.getState().seen };
    expect(countUnread(threads, state)).toBe(2);

    store.markSeen('a', Date.parse(micro));
    store.markSeen('b', Date.parse(micro));
    expect(countUnread(threads, { baseline: base, seen: store.getState().seen })).toBe(0);

    const later = thread('a', '2026-11-04T20:00:01.000Z');
    expect(countUnread([later], { baseline: base, seen: store.getState().seen })).toBe(1);
  });

  it("does not count a thread whose newest message is the person's own, once the server says so", () => {
    const own = { ...thread('a', '2026-11-04T20:00:05.000Z'), last_message_from_me: true };
    expect(countUnread([own], { baseline: 0, seen: {} })).toBe(0);
  });

  it('starts over on reset', () => {
    const store = createSeenStore();
    store.markSeen('a', Date.now() + 1000);
    store.reset();
    expect(store.getState().seen).toEqual({});
  });
});
