/**
 * SIGTERM/SIGINT handling shared by the API process and the job-worker loop.
 *
 * `close` runs once: a second signal exits at once instead of closing again, and a close
 * that outlasts `timeoutMs` exits non-zero so a hung pool or socket cannot stall a deploy.
 */

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface ShutdownOptions {
  readonly timeoutMs?: number;
  readonly onSignal?: (signal: NodeJS.Signals) => void;
  /** Test seam; defaults to `process.exit`. */
  readonly exit?: (code: number) => void;
}

/** Returns the signal handler too, so tests can drive it without sending real signals. */
export function installShutdown(
  close: () => Promise<void>,
  options: ShutdownOptions = {},
): (signal: NodeJS.Signals) => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let closing = false;

  const handle = (signal: NodeJS.Signals): void => {
    if (closing) {
      console.error(JSON.stringify({ msg: 'shutdown_forced', signal }));
      exit(1);
      return;
    }
    closing = true;
    options.onSignal?.(signal);
    const timer = setTimeout(() => {
      console.error(JSON.stringify({ msg: 'shutdown_timeout', timeout_ms: timeoutMs }));
      exit(1);
    }, timeoutMs);
    timer.unref();
    close().then(
      () => {
        clearTimeout(timer);
        exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        console.error(error);
        exit(1);
      },
    );
  };

  process.on('SIGTERM', () => handle('SIGTERM'));
  process.on('SIGINT', () => handle('SIGINT'));
  return handle;
}
