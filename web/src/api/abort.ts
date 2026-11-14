/**
 * Abort helpers for browsers that lack, or only partly have, the newer AbortSignal statics
 * (r267 F2). Per MDN browser-compat-data: `AbortSignal.any` needs Chrome 116, Firefox 124 or
 * Safari 17.4; `AbortSignal.timeout` needs Firefox 100 or Safari 16, and Chrome 103-123 has it
 * only partly (it aborts with an `AbortError`, not a `TimeoutError`). Where a static exists it
 * is used; elsewhere the same signal is built by hand, so a request still times out, a timeout
 * still reads as a timeout, and a caller's abort still cancels.
 */

/** A signal that aborts with a `TimeoutError` after `ms`, whatever reason the browser gives. */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const fire = () => {
    controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  };
  if ('timeout' in AbortSignal && typeof AbortSignal.timeout === 'function') {
    AbortSignal.timeout(ms).addEventListener('abort', fire, { once: true });
  } else {
    setTimeout(fire, ms);
  }
  return controller.signal;
}

/** A signal that aborts as soon as any of `signals` does, with that signal's reason. */
export function anySignal(signals: readonly AbortSignal[]): AbortSignal {
  if ('any' in AbortSignal && typeof AbortSignal.any === 'function') {
    return AbortSignal.any([...signals]);
  }
  const controller = new AbortController();
  const already = signals.find((signal) => signal.aborted);
  if (already) {
    controller.abort(already.reason);
    return controller.signal;
  }
  const onAbort = (event: Event) => {
    for (const signal of signals) signal.removeEventListener('abort', onAbort);
    controller.abort((event.target as AbortSignal).reason);
  };
  for (const signal of signals) signal.addEventListener('abort', onAbort);
  return controller.signal;
}
