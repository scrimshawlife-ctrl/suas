import { describe, expect, it } from 'vitest';
import {
  formatMessageTime,
  insertMessage,
  isMine,
  runEnds,
  toOldestFirst,
  type ChatMessage,
  type MessagesData,
} from './messages';

const ME = 'user-me';
const THEM = 'user-them';

function msg(n: number, sender = THEM): ChatMessage {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return {
    chat_message_id: id,
    service_request_id: 'req-1',
    sender_user_id: sender,
    body: `message ${String(n)}`,
    created_at: `2026-11-04T20:00:${String(n).padStart(2, '0')}.000000Z`,
  };
}

/** Pages as the API sends them: each page newest first, page 2 older than page 1. */
function twoPages(): MessagesData {
  return {
    pageParams: [undefined, 'cursor-1'],
    pages: [
      { messages: [msg(5), msg(4), msg(3)], next_cursor: 'cursor-1' },
      { messages: [msg(2), msg(1)], next_cursor: null },
    ],
  };
}

describe('toOldestFirst', () => {
  it('flattens newest-first pages into oldest to newest', () => {
    expect(toOldestFirst(twoPages()).map((m) => m.body)).toEqual([
      'message 1',
      'message 2',
      'message 3',
      'message 4',
      'message 5',
    ]);
  });

  it('shows a message that appears in two pages once', () => {
    const data = twoPages();
    data.pages[1]!.messages.unshift(msg(3));
    expect(toOldestFirst(data)).toHaveLength(5);
  });

  it('is empty before anything loaded', () => {
    expect(toOldestFirst(undefined)).toEqual([]);
  });
});

describe('insertMessage', () => {
  it('puts a new message at the end of the display order', () => {
    const next = insertMessage(twoPages(), msg(6));
    expect(toOldestFirst(next).at(-1)?.body).toBe('message 6');
  });

  it('ignores a message it already holds, even one from an older page', () => {
    const data = twoPages();
    expect(insertMessage(data, msg(5))).toBe(data);
    expect(insertMessage(data, msg(1))).toBe(data);
  });

  it('keeps timestamp order for a late arrival', () => {
    const next = insertMessage(twoPages(), {
      ...msg(9),
      created_at: '2026-11-04T20:00:03.500000Z',
    });
    expect(toOldestFirst(next).map((m) => m.body)).toEqual([
      'message 1',
      'message 2',
      'message 3',
      'message 9',
      'message 4',
      'message 5',
    ]);
  });
});

describe('outgoing and incoming', () => {
  it('compares the sender with the signed-in person', () => {
    expect(isMine(msg(1, ME), ME)).toBe(true);
    expect(isMine(msg(1, THEM), ME)).toBe(false);
    expect(isMine(msg(1, ME), undefined)).toBe(false);
  });

  it('marks the last message of each run for its timestamp line', () => {
    const list = [msg(1, THEM), msg(2, THEM), msg(3, ME), msg(4, THEM)];
    const ends = runEnds(list);
    expect([...ends]).toEqual([
      list[1]!.chat_message_id,
      list[2]!.chat_message_id,
      list[3]!.chat_message_id,
    ]);
  });
});

describe('formatMessageTime', () => {
  it('shows only the time for today and adds the day for older messages', () => {
    const now = new Date(2026, 10, 4, 21, 0);
    const today = new Date(2026, 10, 4, 20, 14).toISOString();
    const lastWeek = new Date(2026, 9, 20, 20, 14).toISOString();
    expect(formatMessageTime(today, now)).toMatch(/^8:14\s?PM$/i);
    expect(formatMessageTime(lastWeek, now)).toMatch(/Oct 20, 8:14\s?PM/i);
    expect(formatMessageTime('not a date', now)).toBe('');
  });
});
