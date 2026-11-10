import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { createOutbox } from './outbox';
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
});
