import { QueryClient } from '@tanstack/react-query';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // A fresh session starts empty, so a screen mounted after another keeps its data
      // for a short while but never shows a stale answer for long.
      queries: { staleTime: 15_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}
