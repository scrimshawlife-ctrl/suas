import { useCallback, useRef } from 'react';

/**
 * Runs one async action at a time and drops calls made while it runs. TanStack Query publishes
 * `isPending` on a later tick, so a button disabled by it still takes the second click of a
 * double click; this ref closes that gap. Rejections are dropped: the mutation's `error` shows them.
 */
export function useSingleFlight(): (action: () => Promise<unknown>) => void {
  const running = useRef(false);
  return useCallback((action: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    const release = () => {
      running.current = false;
    };
    try {
      action().then(release, release);
    } catch (error) {
      release();
      throw error;
    }
  }, []);
}
