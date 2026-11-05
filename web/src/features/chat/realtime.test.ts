import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { ChatRealtime, parseFrame, reconnectDelay, type SocketLike } from './realtime';

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  push(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
  drop() {
    this.onclose?.({} as CloseEvent);
  }
}

const frame = (body: string) =>
  JSON.stringify({
    type: 'chat.message',
    message: {
      chat_message_id: 'm1',
      service_request_id: 'r1',
      sender_user_id: 'u2',
      body,
      created_at: '2026-11-04T20:00:00.000000Z',
    },
  });

type Ticket = { ticket: string; websocket_url: string };

/** `impl(callNumber)` supplies each ticket response; by default every call issues a new ticket. */
function setup(
  impl: (call: number) => Promise<Ticket> = (call) =>
    Promise.resolve({ ticket: `ticket-${String(call)}`, websocket_url: 'ws://127.0.0.1:3171' }),
) {
  const sockets: FakeSocket[] = [];
  const onMessage = vi.fn();
  const onStatus = vi.fn();
  const onResync = vi.fn();
  let calls = 0;
  const fetchTicket = vi.fn(() => {
    calls += 1;
    return impl(calls);
  });
  const realtime = new ChatRealtime(
    {
      fetchTicket,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      onMessage,
      onStatus,
      onResync,
    },
    () => 1,
  );
  return { realtime, sockets, fetchTicket, onMessage, onStatus, onResync };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('parseFrame', () => {
  it('reads a chat.message frame and ignores everything else', () => {
    expect(parseFrame(frame('hi'))?.body).toBe('hi');
    expect(parseFrame(JSON.stringify({ type: 'ping' }))).toBeUndefined();
    expect(parseFrame('not json')).toBeUndefined();
    expect(
      parseFrame(JSON.stringify({ type: 'chat.message', message: { body: 'x' } })),
    ).toBeUndefined();
    expect(parseFrame(new ArrayBuffer(2))).toBeUndefined();
  });
});

describe('ChatRealtime', () => {
  it('connects with the ticket in the URL and nothing else, then goes live', async () => {
    const { realtime, sockets, onStatus, onResync } = setup();
    realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]?.url).toBe('ws://127.0.0.1:3171/?ticket=ticket-1');
    sockets[0]?.open();
    expect(onStatus).toHaveBeenLastCalledWith('live');
    expect(onResync).toHaveBeenCalledTimes(1);
  });

  it('hands pushed messages on and drops frames it cannot read', async () => {
    const { realtime, sockets, onMessage } = setup();
    realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();
    sockets[0]?.push(frame('hello'));
    sockets[0]?.push('garbage');
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ body: 'hello' });
  });

  it('reconnects after a close with a fresh ticket, after the backoff, and resyncs', async () => {
    const { realtime, sockets, fetchTicket, onStatus, onResync } = setup();
    realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();
    sockets[0]?.drop();
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    expect(sockets[0]?.closed).toBe(true);
    expect(fetchTicket).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(reconnectDelay(1, () => 1));
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    expect(sockets[1]?.url).toContain('ticket=ticket-2');
    sockets[1]?.open();
    expect(onStatus).toHaveBeenLastCalledWith('live');
    expect(onResync).toHaveBeenCalledTimes(2);
  });

  it('backs off further while the server stays down, then resets once connected', async () => {
    const { realtime, sockets, fetchTicket } = setup((call) =>
      call <= 2
        ? Promise.reject(new TypeError('network'))
        : Promise.resolve({ ticket: 't3', websocket_url: 'ws://127.0.0.1:3171' }),
    );
    realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(reconnectDelay(1, () => 1) - 1);
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    // The second wait is longer than the first.
    expect(reconnectDelay(2, () => 1)).toBeGreaterThan(reconnectDelay(1, () => 1));
    await vi.advanceTimersByTimeAsync(reconnectDelay(2, () => 1));
    expect(fetchTicket).toHaveBeenCalledTimes(3);
    expect(sockets[0]?.url).toContain('ticket=t3');
  });

  it('reports polling and stays quiet when push is unavailable (503)', async () => {
    const fetchTicket = vi
      .fn()
      .mockRejectedValue(
        new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'Live chat updates are not available.'),
      );
    const { realtime, sockets, onStatus } = setup(fetchTicket);
    realtime.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onStatus).toHaveBeenLastCalledWith('polling');
    expect(fetchTicket).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(0);
  });

  it('closes the socket and cancels a pending reconnect on stop', async () => {
    const { realtime, sockets, fetchTicket } = setup();
    realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();
    sockets[0]?.drop();
    realtime.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchTicket).toHaveBeenCalledTimes(1);

    const second = setup();
    second.realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    second.realtime.stop();
    expect(second.sockets[0]?.closed).toBe(true);
  });
});
