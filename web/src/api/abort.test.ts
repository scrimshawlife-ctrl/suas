import { afterEach, describe, expect, it, vi } from 'vitest';
import { anySignal, timeoutSignal } from './abort';
import { createApiClient } from './client';

type Statics = { any?: unknown; timeout?: unknown };
const statics = AbortSignal as unknown as Statics;
const realAny = statics.any;
const realTimeout = statics.timeout;

/** Runs as a browser without AbortSignal.any (and, if asked, without AbortSignal.timeout). */
function withoutStatics(names: (keyof Statics)[]) {
  for (const name of names) {
    Object.defineProperty(AbortSignal, name, {
      value: undefined,
      configurable: true,
      writable: true,
    });
    delete statics[name];
  }
}

afterEach(() => {
  Object.defineProperty(AbortSignal, 'any', { value: realAny, configurable: true, writable: true });
  Object.defineProperty(AbortSignal, 'timeout', {
    value: realTimeout,
    configurable: true,
    writable: true,
  });
  vi.useRealTimers();
});

// A fetch on a dead connection: it rejects with the reason once its signal aborts.
const hang = (request: Request) =>
  new Promise<Response>((_, reject) => {
    const fail = () => {
      reject(request.signal.reason as Error);
    };
    if (request.signal.aborted) fail();
    else request.signal.addEventListener('abort', fail);
  });

describe('abort fallbacks for older browsers (r267 F2)', () => {
  it('anySignal aborts with the first reason, without AbortSignal.any', () => {
    withoutStatics(['any']);
    expect('any' in AbortSignal).toBe(false);
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);
    b.abort(new DOMException('gone', 'TimeoutError'));
    expect(combined.aborted).toBe(true);
    expect((combined.reason as DOMException).name).toBe('TimeoutError');
    a.abort();
    expect((combined.reason as DOMException).name).toBe('TimeoutError');
  });

  it('anySignal is already aborted when an input is', () => {
    withoutStatics(['any']);
    const a = new AbortController();
    a.abort(new DOMException('stop', 'AbortError'));
    expect(anySignal([a.signal, new AbortController().signal]).aborted).toBe(true);
  });

  it('timeoutSignal fires a TimeoutError, without AbortSignal.timeout', () => {
    vi.useFakeTimers();
    withoutStatics(['timeout']);
    const signal = timeoutSignal(30_000);
    vi.advanceTimersByTime(29_999);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect((signal.reason as DOMException).name).toBe('TimeoutError');
  });

  it('a Chrome 103-123 timeout (an AbortError) still reads as a 408 TIMEOUT', async () => {
    // That AbortSignal.timeout aborts with AbortError, not TimeoutError (MDN compat data).
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException('aborted', 'AbortError'));
      }, 20);
      return controller.signal;
    });
    const client = createApiClient({ baseUrl: 'http://localhost', fetch: hang });
    await expect(
      client.PUT('/api/v0/veterans/me/county', { body: { county: 'ALAMEDA' } }),
    ).rejects.toMatchObject({ status: 408, code: 'TIMEOUT' });
    vi.restoreAllMocks();
  });

  it('a request with no answer is still a 408 TIMEOUT on a browser with neither static', async () => {
    vi.useFakeTimers();
    withoutStatics(['any', 'timeout']);
    const client = createApiClient({ baseUrl: 'http://localhost', fetch: hang });
    const pending = client
      .PUT('/api/v0/veterans/me/county', { body: { county: 'ALAMEDA' } })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ status: 408, code: 'TIMEOUT' });
  });

  it("the caller's own abort is still an abort on a browser without AbortSignal.any", async () => {
    withoutStatics(['any']);
    const client = createApiClient({ baseUrl: 'http://localhost', fetch: hang });
    const controller = new AbortController();
    const pending = client.GET('/api/v0/health', { signal: controller.signal });
    controller.abort();
    const error: unknown = await pending.catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
  });
});
