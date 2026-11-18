import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../../api/token-store';
import { useLicenceReviews } from './licence-api';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

describe('licence review queue', () => {
  it('sends nothing without a session token, then loads once signed in', async () => {
    tokenStore.clear();
    client.GET.mockReset().mockResolvedValue({
      data: { reviews: [], limit: 20, next_cursor: null },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLicenceReviews(), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(client.GET).not.toHaveBeenCalled();
    act(() => tokenStore.setToken('tok', { mfaElevated: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.GET).toHaveBeenCalledTimes(1);
  });
});
