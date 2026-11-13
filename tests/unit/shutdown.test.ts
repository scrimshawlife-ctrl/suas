/**
 * Shutdown runs `close` once, forces exit on a second signal, and gives up after the
 * timeout (A4-22).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdown } from '../../src/cli/shutdown.js';

afterEach(() => {
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('installShutdown', () => {
  it('closes once and exits 0; a second signal exits 1 without closing again', async () => {
    const close = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 10)));
    const exit = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = installShutdown(close, { exit });

    handle('SIGTERM');
    handle('SIGINT');
    expect(close).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledOnce();
  });

  it('exits 1 when close outlasts the timeout', () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handle = installShutdown(() => new Promise<void>(() => undefined), {
      exit,
      timeoutMs: 1_000,
    });

    handle('SIGTERM');
    vi.advanceTimersByTime(1_000);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
