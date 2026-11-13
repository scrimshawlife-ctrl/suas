/**
 * API.md §6 envelope for failures outside route code, and content-free logs
 * (SECURITY.md §2). Findings A5-09, A5-10, A5-11, A1-20, A4-07.
 */

import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfig } from '../../src/config/index.js';
import { createServer } from '../../src/http/server.js';
import { serializeError, serializeRequest } from '../../src/http/request-logging.js';
import type { BuildInfo } from '../../src/provenance/build-info.js';
import { validEnv } from '../helpers/env.js';

function probeServer() {
  const app = createServer({
    config: loadConfig(validEnv()),
    buildInfo: () => ({}) as BuildInfo,
    logger: false,
  });
  app.post('/api/v0/probe', (request) => {
    z.object({ category: z.enum(['FOOD', 'SHELTER', 'TRANSPORTATION']) }).parse(request.body);
    return { ok: true };
  });
  app.get('/api/v0/probe/:id', () => ({ ok: true }));
  app.get('/api/v0/probe-failure', () => {
    throw Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      detail: 'Key (email)=(someone@example.invalid) already exists.',
    });
  });
  return app;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('error envelope outside route code', () => {
  it('answers a schema failure with a short message and per-field details', async () => {
    const app = probeServer();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v0/probe',
      payload: { category: 'NOPE' },
    });
    expect(response.statusCode).toBe(400);
    const { error } = response.json();
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('category: Invalid value.');
    expect(error.details.issues).toEqual([
      { path: 'category', code: 'invalid_enum_value', message: 'Invalid value.' },
    ]);
    expect(response.body).not.toContain('SHELTER');
    expect(response.body).not.toContain('NOPE');
  });

  it('answers an over-long path parameter with a 400 envelope that does not echo the URL', async () => {
    const app = probeServer();
    const long = 'a'.repeat(200);
    const response = await app.inject({ method: 'GET', url: `/api/v0/probe/${long}` });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'The request is malformed.' },
    });
    expect(response.headers['x-request-id']).toBeDefined();
  });

  it('maps an oversized body to 413 VALIDATION_FAILED and bad JSON to a fixed message', async () => {
    const app = probeServer();
    const large = await app.inject({
      method: 'POST',
      url: '/api/v0/probe',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ category: 'x'.repeat(1_100_000) }),
    });
    expect(large.statusCode).toBe(413);
    expect(large.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'The request body is too large.' },
    });

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v0/probe',
      headers: { 'content-type': 'application/json' },
      payload: '{"secret-body-text',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_FAILED');
    expect(malformed.body).not.toContain('secret-body-text');
  });

  it('answers oversized headers with a 431 envelope', async () => {
    const app = probeServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const { port } = app.server.address() as AddressInfo;
      const raw = await new Promise<string>((resolve, reject) => {
        let received = '';
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            `GET /api/v0/health HTTP/1.1\r\nHost: localhost\r\nX-Big: ${'h'.repeat(20_000)}\r\n\r\n`,
          );
        });
        socket.on('data', (chunk) => (received += chunk.toString('utf8')));
        socket.on('close', () => resolve(received));
        socket.on('error', reject);
      });
      expect(raw.startsWith('HTTP/1.1 431')).toBe(true);
      const body = JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4)) as unknown;
      expect(body).toEqual({
        error: { code: 'VALIDATION_FAILED', message: 'The request headers are too large.' },
      });
    } finally {
      await app.close();
    }
  });
});

describe('content-free request logs', () => {
  it('drops the query string from logged requests', () => {
    expect(
      serializeRequest({
        method: 'GET',
        url: '/auth/va/callback?code=oauth-code&state=s',
        host: 'h',
        ip: '127.0.0.1',
      }),
    ).toEqual({ method: 'GET', url: '/auth/va/callback', host: 'h', remoteAddress: '127.0.0.1' });
  });

  it('logs a 5xx by name, code and route only, without message or driver detail', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    const app = probeServer();
    const response = await app.inject({ method: 'GET', url: '/api/v0/probe-failure?x=private' });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Unexpected internal failure.',
    });

    const logged = lines.join('\n');
    expect(logged).toContain('"route":"/api/v0/probe-failure"');
    expect(logged).toContain('"code":"23505"');
    expect(logged).not.toContain('example.invalid');
    expect(logged).not.toContain('duplicate key');
    expect(logged).not.toContain('private');

    const serialized = JSON.stringify(serializeError(new Error('quoted input')));
    expect(serialized).not.toContain('quoted input');
  });
});
