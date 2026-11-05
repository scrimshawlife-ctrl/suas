import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { isApiError } from '../../api/errors';
import { queryKeys, resourceKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import { serviceRequestQueryOptions } from '../../api/service-requests';
import { useSessionToken } from '../../api/token-store';
import type { Schemas, ServiceCategory } from '../../api/types';
import { isSettled } from './request-card';

export type IntakeTurn = Schemas['IntakeTurn'];
export type IntakeDraft = Schemas['IntakeDraft'];
export type IntakeResource = Schemas['IntakeResource'];

/** Detail polling while a request is open: "every ~15 s" (sprint 2 brief). */
export const REQUEST_POLL_MS = 15_000;

const intakeKeys = resourceKeys('intake');

/** GET /intake/status: whether to offer the assistant. */
export function useIntakeStatus() {
  const token = useSessionToken();
  return useQuery({
    queryKey: intakeKeys.detail('status'),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/intake/status');
      return requireData(data, 'assistant status');
    },
    enabled: token !== null,
    // A gate error will not change on retry; the page redirects.
    retry: (count, error) => !(isApiError(error) && error.status < 500) && count < 2,
    staleTime: 0,
  });
}

/** POST /intake/drafts, then POST /intake/drafts/{id}/messages for each follow-up. */
export function useSendIntakeMessage() {
  return useMutation({
    mutationFn: async (input: { draftId: string | null; text: string }): Promise<IntakeTurn> => {
      if (input.draftId === null) {
        const { data } = await api.POST('/api/v0/intake/drafts', { body: { text: input.text } });
        return requireData(data, 'assistant reply');
      }
      const { data } = await api.POST('/api/v0/intake/drafts/{id}/messages', {
        params: { path: { id: input.draftId } },
        body: { text: input.text },
      });
      return requireData(data, 'assistant reply');
    },
  });
}

export interface DraftEdit {
  category?: ServiceCategory;
  summary?: string;
  timing?: string | null;
  meeting_place?: string | null;
}

/** PATCH /intake/drafts/{id}: only the fields that changed. */
export function useUpdateDraft() {
  return useMutation({
    mutationFn: async (input: { draftId: string; edit: DraftEdit }): Promise<IntakeDraft> => {
      const { data } = await api.PATCH('/api/v0/intake/drafts/{id}', {
        params: { path: { id: input.draftId } },
        body: input.edit,
      });
      return requireData(data, 'draft');
    },
  });
}

/** After a request exists: refresh everything that lists or summarises requests. */
function useRequestCreated() {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.me }),
    ]);
  };
}

/** POST /intake/drafts/{id}/submit. `idempotencyKey` is one per submit action. */
export function useSubmitDraft() {
  const created = useRequestCreated();
  return useMutation({
    mutationFn: async (input: { draftId: string; idempotencyKey: string }) => {
      const { data } = await api.POST('/api/v0/intake/drafts/{id}/submit', {
        params: { path: { id: input.draftId } },
        headers: { 'Idempotency-Key': input.idempotencyKey },
      });
      return requireData(data, 'request').service_request;
    },
    onSuccess: created,
  });
}

export interface FormBody {
  category: ServiceCategory;
  summary: string;
  timing?: string;
  meeting_place?: string;
}

/** POST /service-requests: the plain form. */
export function useCreateRequest() {
  const created = useRequestCreated();
  return useMutation({
    mutationFn: async (input: { body: FormBody; idempotencyKey: string }) => {
      const { data } = await api.POST('/api/v0/service-requests', {
        body: input.body,
        headers: { 'Idempotency-Key': input.idempotencyKey },
      });
      return requireData(data, 'request');
    },
    onSuccess: created,
  });
}

/**
 * The owner's request read. While the request is open it refetches every 15 s and refreshes
 * `me` alongside, so `active_qrf` (the authority for the NOTIFIED card) never lags the read.
 */
export function useRequestDetail(id: string | undefined) {
  const token = useSessionToken();
  const queryClient = useQueryClient();
  const query = useQuery({
    ...serviceRequestQueryOptions(id ?? ''),
    enabled: token !== null && id !== undefined && id !== '',
    refetchInterval: (q) => (isSettled(q.state.data?.status) ? false : REQUEST_POLL_MS),
    retry: (count, error) => !(isApiError(error) && error.status < 500) && count < 2,
  });

  const seen = useRef(0);
  const updatedAt = query.dataUpdatedAt;
  const status = query.data?.status;
  useEffect(() => {
    const first = seen.current === 0;
    seen.current = updatedAt;
    if (first || updatedAt === 0 || isSettled(status)) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [updatedAt, status, queryClient]);

  return query;
}

type OwnerCommand = 'CANCEL' | 'CONFIRM';

/**
 * The reason sent with CANCEL, which the API requires. Fixed on purpose: a free-text reason
 * would put what the person typed into the request record.
 */
export const CANCEL_REASON = 'Cancelled by the requester';

/** CANCEL and CONFIRM: requester-only commands on one request. */
export function useRequestCommand(requestId: string, command: OwnerCommand) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (idempotencyKey: string) => {
      const { data } = await api.POST('/api/v0/service-requests/{id}/commands/{command}', {
        params: { path: { id: requestId, command } },
        body: command === 'CANCEL' ? { reason: CANCEL_REASON } : {},
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      return requireData(data, 'request');
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
      ]);
    },
  });
}
