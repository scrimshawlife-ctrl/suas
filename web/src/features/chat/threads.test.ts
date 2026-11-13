import { describe, expect, it } from 'vitest';
import type { ChatThread } from '../../api/types';
import { allThreads, isReadOnly, pickThread, threadHref, threadKey } from './threads';

const thread = (id: string, releasedAt: string | null, request = 'r1'): ChatThread => ({
  chat_thread_id: id,
  service_request_id: request,
  category: 'FOOD',
  summary: null,
  counterpart_display_name: null,
  last_message_body: null,
  last_message_at: null,
  closed: false,
  released_at: releasedAt,
  role: 'REQUESTER',
  last_message_from_me: null,
});

const live = thread('t-live', null);
const old = thread('t-old', '2026-11-09T10:00:00Z');

describe('thread helpers', () => {
  it('reads a released_at thread as read-only, and a missing or null one as live', () => {
    expect(isReadOnly(old)).toBe(true);
    expect(isReadOnly(live)).toBe(false);
    expect(isReadOnly({ ...live, released_at: undefined })).toBe(false);
    expect(isReadOnly(undefined)).toBe(false);
  });

  it('links a live thread to the request path and a closed one with its thread id', () => {
    expect(threadHref(live)).toBe('/chat/r1');
    expect(threadHref(old)).toBe('/chat/r1?thread=t-old');
  });

  it('keys by thread id, falling back to the request for an older server', () => {
    expect(threadKey(live)).toBe('t-live');
    expect(threadKey({ ...live, chat_thread_id: undefined })).toBe('r1');
  });

  it('picks the named thread, else the live one, else the newest', () => {
    const list = [old, live, thread('other', null, 'r2')];
    expect(pickThread(list, 'r1', 't-old')).toBe(old);
    expect(pickThread(list, 'r1', null)).toBe(live);
    expect(pickThread([old], 'r1', null)).toBe(old);
    expect(pickThread(list, 'r1', 'unknown')).toBeUndefined();
    expect(pickThread(undefined, 'r1', null)).toBeUndefined();
  });
});

describe('allThreads', () => {
  it('joins the pages and keeps the first copy of a thread that moved between page reads', () => {
    const other = thread('t-other', null, 'r2');
    const pages = { pages: [{ threads: [live, other] }, { threads: [other, old] }] };
    expect(allThreads(pages)?.map(threadKey)).toEqual(['t-live', 't-other', 't-old']);
    expect(allThreads(undefined)).toBeUndefined();
  });
});
