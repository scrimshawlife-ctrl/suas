/**
 * Local WebSocket server for the connection push port (LOCAL, TEST and dev only).
 *
 * Plan citation: V1_PROJECT_PLAN.md §2.2 (Chat), §4.3 F7; AGENTS.md rule 7 (a
 * local stand-in where the real provider is unavailable). It speaks just enough of
 * RFC 6455 for a browser or Node client to connect, receive text frames and close:
 * the server never needs to read client messages, because messages are sent over
 * REST. Its open sockets are process-local, which is why config refuses this mode
 * outside LOCAL and TEST. The registry of who is connected stays in Postgres.
 *
 * A client connects to `ws://host:port/?ticket=<one-time ticket>`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ConnectionPushPort, PushOutcome } from './connection-push.js';
import type { ConnectionLifecycle } from './lifecycle.js';

export const LOCAL_WEBSOCKET_IMPLEMENTATION = 'local-websocket' as const;

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
/** Client frames are only close and ping in practice; refuse anything large. */
const MAX_BUFFERED_BYTES = 64 * 1024;

/** One unmasked server-to-client frame. */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

interface ClientFrame {
  readonly opcode: number;
  readonly payload: Buffer;
  readonly consumed: number;
}

/** The first complete client frame in `buffer`, or undefined if more bytes are needed. */
function decodeClientFrame(buffer: Buffer): ClientFrame | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
  }
  return { opcode, payload, consumed: offset + maskLength + length };
}

export class LocalWebSocketPush implements ConnectionPushPort {
  readonly implementation = LOCAL_WEBSOCKET_IMPLEMENTATION;

  private readonly server: Server;
  private readonly sockets = new Map<string, Duplex>();
  private host = '127.0.0.1';

  constructor(private readonly lifecycle: ConnectionLifecycle) {
    this.server = createServer((_request, response) => {
      response.statusCode = 426;
      response.end();
    });
    this.server.on('upgrade', (request, socket) => {
      void this.accept(request, socket);
    });
  }

  /** Starts listening; pass port 0 for an ephemeral port. Resolves the bound port. */
  listen(port: number, host = '127.0.0.1'): Promise<number> {
    this.host = host;
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  connectUrl(): string {
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('The local WebSocket server is not listening.');
    }
    return `ws://${this.host}:${String(address.port)}`;
  }

  send(connectionId: string, payload: string): Promise<PushOutcome> {
    const socket = this.sockets.get(connectionId);
    if (socket === undefined || socket.destroyed) return Promise.resolve('gone');
    socket.write(encodeFrame(OPCODE_TEXT, Buffer.from(payload, 'utf8')));
    return Promise.resolve('delivered');
  }

  async close(): Promise<void> {
    for (const socket of this.sockets.values()) socket.destroy();
    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => {
        resolve();
      });
    });
  }

  private async accept(request: IncomingMessage, socket: Duplex): Promise<void> {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    const connectionId = randomUUID();
    let closed = false;
    socket.on('error', () => {
      socket.destroy();
    });
    socket.on('close', () => {
      closed = true;
      this.sockets.delete(connectionId);
      void this.lifecycle.disconnect(connectionId).catch(() => undefined);
    });

    const ticket = new URL(request.url ?? '/', 'http://localhost').searchParams.get('ticket');
    let outcome: 'accepted' | 'refused';
    try {
      outcome = await this.lifecycle.connect({ connectionId, ticket: ticket ?? undefined });
    } catch {
      socket.end(
        'HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\ncontent-length: 0\r\n\r\n',
      );
      return;
    }
    if (outcome === 'refused') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    if (closed) {
      // The client left while we were authenticating; the close handler already ran
      // before registration, so drop the entry connect just made.
      await this.lifecycle.disconnect(connectionId).catch(() => undefined);
      return;
    }

    const accept = createHash('sha1')
      .update(key + HANDSHAKE_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'upgrade: websocket\r\n' +
        'connection: Upgrade\r\n' +
        `sec-websocket-accept: ${accept}\r\n\r\n`,
    );
    this.sockets.set(connectionId, socket);
    this.readClientFrames(socket);
  }

  /** Answers ping and close; every other client frame is ignored (sending is REST). */
  private readClientFrames(socket: Duplex): void {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_BUFFERED_BYTES) {
        socket.destroy();
        return;
      }
      for (let frame = decodeClientFrame(buffered); frame; frame = decodeClientFrame(buffered)) {
        buffered = buffered.subarray(frame.consumed);
        if (frame.opcode === OPCODE_CLOSE) {
          socket.end(encodeFrame(OPCODE_CLOSE, Buffer.alloc(0)));
          return;
        }
        if (frame.opcode === OPCODE_PING) socket.write(encodeFrame(OPCODE_PONG, frame.payload));
      }
    });
  }
}
