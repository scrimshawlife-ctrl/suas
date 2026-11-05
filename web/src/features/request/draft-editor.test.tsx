import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntakeDraft } from './api';
import { useDraftEditor } from './draft-editor';

const { patch } = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock('../../api/client', () => ({ api: { PATCH: patch } }));

const draft: IntakeDraft = {
  draft_id: '33333333-3333-4333-8333-333333333333',
  status: 'DRAFT',
  category: 'FOOD',
  summary: 'Groceries',
  timing: null,
  meeting_place: null,
  service_request_id: null,
  created_at: '2026-11-04T00:00:00.000Z',
  updated_at: '2026-11-04T00:00:00.000Z',
  submitted_at: null,
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  patch.mockReset();
});

describe('useDraftEditor', () => {
  it('runs saves one at a time, in order, so two PATCHes never overlap', async () => {
    const release: (() => void)[] = [];
    let running = 0;
    let overlapped = false;
    patch.mockImplementation((_path: string, options: { body: Record<string, unknown> }) => {
      running += 1;
      overlapped ||= running > 1;
      return new Promise((resolve) => {
        release.push(() => {
          running -= 1;
          resolve({ data: { ...draft, ...options.body } });
        });
      });
    });
    const { result } = renderHook(() => useDraftEditor(draft), { wrapper });
    act(() => result.current.change({ meetingPlace: 'Library' }));

    let first!: Promise<IntakeDraft>;
    let second!: Promise<IntakeDraft>;
    act(() => {
      first = result.current.save();
      second = result.current.save();
    });
    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    act(() => release[0]?.());
    await first;
    // The second save sees the first one's result, so it has nothing left to send.
    await expect(second).resolves.toMatchObject({ meeting_place: 'Library' });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(overlapped).toBe(false);
  });

  it('rejects when the PATCH fails and lets the next save try again', async () => {
    patch.mockRejectedValueOnce(new Error('boom'));
    patch.mockResolvedValueOnce({ data: { ...draft, meeting_place: 'Library' } });
    const { result } = renderHook(() => useDraftEditor(draft), { wrapper });
    act(() => result.current.change({ meetingPlace: 'Library' }));
    await expect(result.current.save()).rejects.toThrow('boom');
    await expect(result.current.save()).resolves.toMatchObject({ meeting_place: 'Library' });
  });
});
