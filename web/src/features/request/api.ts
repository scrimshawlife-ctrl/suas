import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useBodyIdempotencyKey, useIdempotencyKey } from '../../api/idempotency';
import { queryKeys } from '../../api/keys';
import { useSignedInQuery } from '../../api/queries';
import { requireData } from '../../api/require-data';
import { serviceRequestQueryOptions } from '../../api/service-requests';
import type { Schemas, ServiceCategory } from '../../api/types';
import { REQUEST_POLL_MS } from '../../app/poll-intervals';
import { isDraftGone, openDraft } from './open-draft';
import { isSettled } from './request-card';

export type IntakeTurn = Schemas['IntakeTurn'];
export type IntakeDraft = Schemas['IntakeDraft'];
export type IntakeDraftWithText = Schemas['IntakeDraftWithText'];

/** GET /intake/status: whether to offer the assistant. */
export function useIntakeStatus() {
  return useSignedInQuery({
    queryKey: queryKeys.intake.detail('status'),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/intake/status');
      return requireData(data, 'assistant status');
    },
    staleTime: 0,
  });
}

/** A gone draft (404, or no longer DRAFT) is not resumed after a reload. */
function dropGoneDraft(error: unknown): void {
  if (isDraftGone(error)) openDraft.clear();
}

/**
 * GET /intake/drafts/{id} for the draft id kept across a reload (R12.1). Resolves to null,
 * and forgets the id, when the draft is gone or no longer DRAFT. Never served from cache.
 */
export function useOpenDraft() {
  const [draftId] = useState(() => openDraft.get());
  return useSignedInQuery({
    queryKey: queryKeys.intake.detail(draftId ?? ''),
    enabled: draftId !== null,
    queryFn: async (): Promise<IntakeDraftWithText | null> => {
      try {
        const { data } = await api.GET('/api/v0/intake/drafts/{id}', {
          params: { path: { id: draftId ?? '' } },
        });
        const draft = requireData(data, 'draft');
        if (draft.status === 'DRAFT') return draft;
        openDraft.clear();
        return null;
      } catch (error) {
        if (!isDraftGone(error)) throw error;
        openDraft.clear();
        return null;
      }
    },
    gcTime: 0,
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
    onSuccess: (turn) => {
      if (turn.draft?.status === 'DRAFT') openDraft.set(turn.draft.draft_id);
    },
    onError: dropGoneDraft,
  });
}

export interface DraftEdit {
  category?: ServiceCategory;
  summary?: string;
  timing?: string | null;
  meeting_place?: string | null;
  destination?: string | null;
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
    onError: dropGoneDraft,
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

/**
 * POST /intake/drafts/{id}/submit. Key: one per card, kept across retries and renewed only after
 * a success.
 */
export function useSubmitDraft() {
  const created = useRequestCreated();
  const key = useIdempotencyKey();
  return useMutation({
    mutationFn: async (draftId: string) => {
      const { data } = await api.POST('/api/v0/intake/drafts/{id}/submit', {
        params: { path: { id: draftId } },
        headers: key.headers(),
      });
      return requireData(data, 'request').service_request;
    },
    onSuccess: async () => {
      key.renew();
      openDraft.clear();
      await created();
    },
    onError: dropGoneDraft,
  });
}

export interface FormBody {
  category: ServiceCategory;
  summary: string;
  timing?: string;
  meeting_place?: string;
  destination?: string;
}

/**
 * POST /service-requests: the plain form. Key: one per body, so a retry of the same content
 * reuses it and changed content is a new action; renewed after a success.
 */
export function useCreateRequest() {
  const created = useRequestCreated();
  const key = useBodyIdempotencyKey();
  return useMutation({
    mutationFn: async (body: FormBody) => {
      const { data } = await api.POST('/api/v0/service-requests', {
        body,
        headers: key.headers(body),
      });
      return requireData(data, 'request');
    },
    // A request sent through the plain form ends the assistant's draft too, so it cannot return.
    onSuccess: async () => {
      key.renew();
      openDraft.clear();
      await created();
    },
  });
}

/**
 * The owner's request read. While the request is open it refetches every 15 s and refreshes
 * `me` alongside, so `active_qrf` (the authority for the NOTIFIED card) never lags the read.
 * The read that first shows a settled status refreshes `me` too, then polling stops.
 */
export function useRequestDetail(id: string | undefined) {
  const queryClient = useQueryClient();
  const query = useSignedInQuery({
    ...serviceRequestQueryOptions(id ?? ''),
    enabled: id !== undefined && id !== '',
    refetchInterval: (q) => (isSettled(q.state.data?.status) ? false : REQUEST_POLL_MS),
  });

  const seen = useRef(0);
  const updatedAt = query.dataUpdatedAt;
  useEffect(() => {
    const first = seen.current === 0;
    seen.current = updatedAt;
    if (first || updatedAt === 0) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [updatedAt, queryClient]);

  return query;
}

type OwnerCommand = 'CANCEL' | 'CONFIRM';

/**
 * The reason sent with CANCEL, which the API requires. Fixed on purpose: a free-text reason
 * would put what the person typed into the request record.
 */
const CANCEL_REASON = 'Cancelled by the requester';

/**
 * CANCEL and CONFIRM: requester-only commands on one request. Key: one per button, kept across
 * retries and renewed only after a success.
 */
export function useRequestCommand(requestId: string, command: OwnerCommand) {
  const queryClient = useQueryClient();
  const key = useIdempotencyKey();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST('/api/v0/service-requests/{id}/commands/{command}', {
        params: { path: { id: requestId, command } },
        body: command === 'CANCEL' ? { reason: CANCEL_REASON } : {},
        headers: key.headers(),
      });
      return requireData(data, 'request');
    },
    onSuccess: async () => {
      key.renew();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
      ]);
    },
  });
}

export type RequestEdit = Schemas['ServiceRequestEditRequest'];

/**
 * POST /service-requests/{id}/commands/edit: the requester changes an unaccepted request.
 * Key: one per body, as the plain form; renewed after a success.
 */
export function useEditRequest(requestId: string) {
  const created = useRequestCreated();
  const key = useBodyIdempotencyKey();
  return useMutation({
    mutationFn: async (edit: RequestEdit) => {
      const { data } = await api.POST('/api/v0/service-requests/{id}/commands/edit', {
        params: { path: { id: requestId } },
        body: edit,
        headers: key.headers(edit),
      });
      return requireData(data, 'request');
    },
    onSuccess: async () => {
      key.renew();
      await created();
    },
  });
}
