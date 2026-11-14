import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS } from '../../api/client';
import { ApiError } from '../../api/errors';
import { createOutbox, SEND_GIVE_UP_MS } from './outbox';
import type { ChatMessage } from './messages';

const sent = (body: string): ChatMessage => ({
  chat_message_id: '00000000-0000-4000-8000-000000000001',
  service_request_id: 'r1',
  sender_user_id: 'me',
  body,
  created_at: '2026-11-04T20:00:00.000000Z',
});

describe('outbox', () => {
  it('keeps a failed send for its conversation and retries with the same key', async () => {
    const send = vi
      .fn<(id: string, body: string, key: string) => Promise<ChatMessage>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(sent('hi'));
    const outbox = createOutbox(send);
    const queryClient = new QueryClient();

    outbox.send(queryClient, 'r1', 'hi');
    expect(outbox.get('r1')[0]?.status).toBe('sending');
    await vi.waitFor(() => {
      expect(outbox.get('r1')[0]?.status).toBe('failed');
    });
    expect(outbox.get('r2')).toHaveLength(0);

    const clientId = outbox.get('r1')[0]?.clientId ?? '';
    outbox.retry(queryClient, 'r1', clientId);
    await vi.waitFor(() => {
      expect(outbox.get('r1')).toHaveLength(0);
    });
    expect(send.mock.calls[1]?.[2]).toBe(send.mock.calls[0]?.[2]);
  });

  it('ignores a send that finishes after clear, so the next person sees nothing of it', async () => {
    let finish: (m: ChatMessage) => void = () => undefined;
    const outbox = createOutbox(
      () =>
        new Promise<ChatMessage>((resolve) => {
          finish = resolve;
        }),
    );
    const queryClient = new QueryClient();
    outbox.send(queryClient, 'r1', 'hi');
    outbox.clear();
    finish(sent('hi'));
    await Promise.resolve();
    expect(outbox.get('r1')).toHaveLength(0);
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('sends one message at a time per conversation, in the order typed (SERVE-6)', async () => {
    const finish: (() => void)[] = [];
    const send = vi.fn(
      (_id: string, body: string) =>
        new Promise<ChatMessage>((resolve) => {
          finish.push(() => {
            resolve(sent(body));
          });
        }),
    );
    const outbox = createOutbox(send);
    const queryClient = new QueryClient();

    outbox.send(queryClient, 'r1', 'first');
    outbox.send(queryClient, 'r1', 'second');
    outbox.send(queryClient, 'r2', 'elsewhere');
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    expect(send.mock.calls.map((call) => call[1])).toEqual(['first', 'elsewhere']);

    finish[0]?.();
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(3);
    });
    expect(send.mock.calls[2]?.[1]).toBe('second');
    expect(outbox.get('r1').map((p) => p.body)).toEqual(['second']);
  });

  it('marks a timed-out send as not sent, so the next message in that chat still goes', async () => {
    // The API client turns a send with no answer into a 408 TIMEOUT after 30 s.
    const send = vi.fn((_id: string, body: string) =>
      body === 'first'
        ? Promise.reject(new ApiError(408, 'TIMEOUT', 'No answer.'))
        : Promise.resolve(sent(body)),
    );
    const outbox = createOutbox(send);
    const queryClient = new QueryClient();

    outbox.send(queryClient, 'r1', 'first');
    outbox.send(queryClient, 'r1', 'second');
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(outbox.get('r1').map((p) => [p.body, p.status])).toEqual([['first', 'failed']]);
    });
  });

  // r268 F3: the outbox's own give-up, for a send whose promise never settles at all.
  it('gives up on a send that never settles, so the next message in that chat still goes', async () => {
    vi.useFakeTimers();
    try {
      const send = vi.fn((_id: string, body: string) =>
        body === 'first' ? new Promise<ChatMessage>(() => undefined) : Promise.resolve(sent(body)),
      );
      const outbox = createOutbox(send);
      const queryClient = new QueryClient();

      outbox.send(queryClient, 'r1', 'first');
      outbox.send(queryClient, 'r1', 'second');
      await vi.advanceTimersByTimeAsync(SEND_GIVE_UP_MS - 1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(outbox.get('r1').map((p) => p.status)).toEqual(['sending', 'sending']);

      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]?.[1]).toBe('second');
      expect(outbox.get('r1').map((p) => [p.body, p.status])).toEqual([['first', 'failed']]);
      // Only a backstop: the API client's own timeout answers first when it works.
      expect(SEND_GIVE_UP_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a send that answers after the give-up still replaces its "Not sent." bubble', async () => {
    vi.useFakeTimers();
    try {
      let finish: (m: ChatMessage) => void = () => undefined;
      const outbox = createOutbox(
        () =>
          new Promise<ChatMessage>((resolve) => {
            finish = resolve;
          }),
      );
      const queryClient = new QueryClient();
      outbox.send(queryClient, 'r1', 'hi');
      await vi.advanceTimersByTimeAsync(SEND_GIVE_UP_MS);
      expect(outbox.get('r1')[0]?.status).toBe('failed');

      finish(sent('hi'));
      await vi.advanceTimersByTimeAsync(0);
      expect(outbox.get('r1')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // G5: a refusal that sending again cannot fix gets no retry; busy or timed out still can.
  it.each([
    ['409 CHAT_CLOSED', new ApiError(409, 'CHAT_CLOSED', 'x'), 'refused', 'This chat is closed.'],
    [
      '409 CHAT_UNAVAILABLE',
      new ApiError(409, 'CHAT_UNAVAILABLE', 'x'),
      'refused',
      'Chat opens once someone accepts your request.',
    ],
    ['413', new ApiError(413, 'PAYLOAD_TOO_LARGE', 'x'), 'refused', 'The message is too long.'],
    ['429', new ApiError(429, 'RATE_LIMITED', 'x'), 'failed', undefined],
    // r268 F1: a retry while the first try is still being stored; the next retry replays it.
    [
      '409 IDEMPOTENCY_CONFLICT',
      new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'x'),
      'failed',
      undefined,
    ],
    ['408 TIMEOUT', new ApiError(408, 'TIMEOUT', 'x'), 'failed', undefined],
    ['503', new ApiError(503, 'UNAVAILABLE', 'x'), 'failed', undefined],
    ['a dropped connection', new TypeError('Failed to fetch'), 'failed', undefined],
  ])('a send rejected with %s is %s', async (_label, error, status, reason) => {
    const send = vi.fn(() => Promise.reject(error));
    const outbox = createOutbox(send);
    const queryClient = new QueryClient();

    outbox.send(queryClient, 'r1', 'hi');
    await vi.waitFor(() => {
      expect(outbox.get('r1')[0]?.status).toBe(status);
    });
    expect(outbox.get('r1')[0]?.reason).toBe(reason);

    outbox.retry(queryClient, 'r1', outbox.get('r1')[0]?.clientId ?? '');
    if (status === 'refused') expect(outbox.get('r1')[0]?.status).toBe('refused');
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(status === 'refused' ? 1 : 2);
    });
  });
});
