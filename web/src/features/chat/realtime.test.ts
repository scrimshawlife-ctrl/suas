import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import {
  ChatRealtime,
  parseFrame,
  POLLING_AFTER_FAILURES,
  reconnectDelay,
  type SocketLike,
} from './realtime';

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
  /** Return a socket, or throw to simulate a setup failure; `n` counts socket attempts. */
  makeSocket: (url: string, n: number) => FakeSocket = (url) => new FakeSocket(url),
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
        const socket = makeSocket(url, sockets.length + 1);
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

  it('keeps retrying when the socket cannot be built, and reports polling after three failures', async () => {
    let built = 0;
    const { realtime, fetchTicket, onStatus, sockets } = setup(undefined, (url) => {
      built += 1;
      if (built <= POLLING_AFTER_FAILURES) throw new SyntaxError('bad url');
      return new FakeSocket(url);
    });
    realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(reconnectDelay(1, () => 1));
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(reconnectDelay(2, () => 1));
    expect(onStatus).toHaveBeenLastCalledWith('polling');

    // It did not give up: the next attempt gets a socket and goes live.
    await vi.advanceTimersByTimeAsync(reconnectDelay(3, () => 1));
    expect(fetchTicket).toHaveBeenCalledTimes(4);
    sockets.at(-1)?.open();
    expect(onStatus).toHaveBeenLastCalledWith('live');
  });

  it('never waits longer than 30 s between attempts', () => {
    expect(reconnectDelay(6, () => 1)).toBe(30_000);
    expect(reconnectDelay(40, () => 1)).toBe(30_000);
    expect(reconnectDelay(40, () => 0)).toBe(15_000);
    expect(reconnectDelay(1, () => 1)).toBe(1000);
  });

  it('restart reconnects at once with a fresh ticket and a reset backoff', async () => {
    const { realtime, sockets, fetchTicket, onStatus } = setup((call) =>
      call <= 3
        ? Promise.reject(new TypeError('network'))
        : Promise.resolve({ ticket: `t${String(call)}`, websocket_url: 'ws://127.0.0.1:3171' }),
    );
    realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    realtime.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchTicket).toHaveBeenCalledTimes(2);
    // The failed second attempt starts over at the shortest wait, not a longer one.
    await vi.advanceTimersByTimeAsync(reconnectDelay(1, () => 1));
    expect(fetchTicket).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(reconnectDelay(2, () => 1));
    expect(sockets[0]?.url).toContain('ticket=t4');
  });

  it('drops a live socket on restart and does not let an attempt in flight open a second one', async () => {
    const { realtime, sockets, fetchTicket } = setup();
    realtime.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();
    realtime.restart();
    realtime.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]?.closed).toBe(true);
    expect(fetchTicket).toHaveBeenCalledTimes(3);
    expect(sockets.filter((socket) => !socket.closed)).toHaveLength(1);
  });
});
