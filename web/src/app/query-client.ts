import { QueryClient } from '@tanstack/react-query';
import { retryServerErrors } from '../api/errors';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // A fresh session starts empty, so a screen mounted after another keeps its data
      // for a short while but never shows a stale answer for long.
      // A 4xx (gate, not found, conflict) shows at once; only server and connection errors retry.
      queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: retryServerErrors },
      mutations: { retry: false },
    },
  });
}
