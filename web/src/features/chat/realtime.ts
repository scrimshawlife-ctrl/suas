import { isApiError } from '../../api/errors';
import type { ChatMessage } from './messages';

export type RealtimeStatus = 'connecting' | 'live' | 'reconnecting' | 'polling';

/** The slice of the browser WebSocket the manager uses, so tests can supply a fake. */
export interface SocketLike {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

export interface RealtimeDeps {
  fetchTicket: () => Promise<{ ticket: string; websocket_url: string }>;
  createSocket: (url: string) => SocketLike;
  onMessage: (message: ChatMessage) => void;
  onStatus: (status: RealtimeStatus) => void;
  /** The socket (re)opened after a gap, so frames may have been missed: refetch over REST. */
  onResync: () => void;
}

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** A `chat.message` frame as the server sends it; anything else is ignored. */
export function parseFrame(data: unknown): ChatMessage | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const frame = JSON.parse(data) as { type?: unknown; message?: Record<string, unknown> };
    const m = frame.message;
    if (frame.type !== 'chat.message' || typeof m !== 'object') return undefined;
    if (
      typeof m.chat_message_id === 'string' &&
      typeof m.service_request_id === 'string' &&
      typeof m.sender_user_id === 'string' &&
      typeof m.body === 'string' &&
      typeof m.created_at === 'string'
    ) {
      return {
        chat_message_id: m.chat_message_id,
        service_request_id: m.service_request_id,
        sender_user_id: m.sender_user_id,
        body: m.body,
        created_at: m.created_at,
      };
    }
  } catch {
    // Not JSON: ignore the frame.
  }
  return undefined;
}

/**
 * Keeps one chat WebSocket open. Each connection redeems a fresh one-time ticket (a ticket
 * is single use and expires in a minute, so a dropped socket can never reuse it) and a
 * drop or error retries with exponential backoff. `CHAT_REALTIME_UNAVAILABLE` (503) means
 * the server has no push configured: the manager stops and reports `polling`.
 * The session token never appears in the URL; only the ticket does.
 */
export class ChatRealtime {
  private socket: SocketLike | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private stopped = true;
  private needsResync = true;

  constructor(
    private readonly deps: RealtimeDeps,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    this.stopped = false;
    this.deps.onStatus('connecting');
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.detach();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let ticket: { ticket: string; websocket_url: string };
    try {
      ticket = await this.deps.fetchTicket();
    } catch (error) {
      if (this.stopped) return;
      if (isApiError(error) && error.code === 'CHAT_REALTIME_UNAVAILABLE') {
        this.deps.onStatus('polling');
        return;
      }
      // A 401 is handled globally (it signs the person out, which stops this manager).
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;

    const url = new URL(ticket.websocket_url);
    url.searchParams.set('ticket', ticket.ticket);
    const socket = this.deps.createSocket(url.toString());
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.deps.onStatus('live');
      if (this.needsResync) this.deps.onResync();
      this.needsResync = false;
    };
    socket.onmessage = (event) => {
      const message = parseFrame(event.data);
      if (message !== undefined && this.socket === socket) this.deps.onMessage(message);
    };
    const dropped = () => {
      if (this.socket !== socket) return;
      this.detach();
      this.scheduleReconnect();
    };
    socket.onclose = dropped;
    socket.onerror = dropped;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.needsResync = true;
    this.attempt += 1;
    this.deps.onStatus('reconnecting');
    this.timer = setTimeout(() => void this.connect(), reconnectDelay(this.attempt, this.random));
  }

  private detach(): void {
    const socket = this.socket;
    this.socket = undefined;
    if (socket === undefined) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}
