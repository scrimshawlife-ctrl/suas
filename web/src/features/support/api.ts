import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys, resourceKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import { useSessionToken } from '../../api/token-store';
import type { Schemas } from '../../api/types';

export type CatalogResource = Schemas['CatalogResource'];
export type CheckInWithQuestions = Schemas['CheckInWithQuestions'];
export type CheckInDetail = Schemas['CheckInDetail'];
export type CheckInCompleted = Schemas['CheckInCompleted'];
export type ConsentGrant = Schemas['ConsentGrant'];
export type TrustedContact = Schemas['TrustedContact'];
export type NotificationItem = Schemas['Notification'];
export type GrantConsentBody = Schemas['GrantConsentRequest'];

/** Keys for resources the shared factory list does not cover yet. */
export const supportKeys = {
  checkIns: resourceKeys('check-ins'),
  consents: resourceKeys('consents'),
  trustedContacts: resourceKeys('trusted-contacts'),
};

const PAGE_SIZE = 10;

/** GET /resources, cursor paged: `fetchNextPage` is "Show more listings". */
export function useResources(category: Schemas['ServiceCategory'] | null, county: string | null) {
  const token = useSessionToken();
  return useInfiniteQuery({
    queryKey: queryKeys.resources.list({ category, county, limit: PAGE_SIZE }),
    enabled: token !== null && category !== null && county !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET('/api/v0/resources', {
        params: {
          query: {
            ...(category ? { category } : {}),
            ...(county ? { county } : {}),
            limit: PAGE_SIZE,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        },
      });
      return requireData(data, 'listings');
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

const RESUMABLE_FILTER = { status: 'IN_PROGRESS' } as const;

/** GET /check-ins?status=IN_PROGRESS: the caller's unfinished Check-In (24 h), or null. */
export function useResumableCheckIn(enabled = true) {
  const token = useSessionToken();
  return useQuery({
    queryKey: supportKeys.checkIns.list(RESUMABLE_FILTER),
    enabled: token !== null && enabled,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/check-ins', {
        params: { query: RESUMABLE_FILTER },
      });
      return requireData(data, 'Check-Ins').check_ins[0] ?? null;
    },
  });
}

/** GET /check-ins/{id}: the questions and which of them already have an answer. */
export function useCheckIn(checkInId: string | undefined) {
  const token = useSessionToken();
  return useQuery({
    queryKey: supportKeys.checkIns.detail(checkInId ?? ''),
    enabled: token !== null && checkInId !== undefined,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/check-ins/{id}', {
        params: { path: { id: checkInId ?? '' } },
      });
      return requireData(data, 'Check-In');
    },
  });
}

/** POST /check-ins: starts one Check-In and returns its questions. */
export function useStartCheckIn() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST('/api/v0/check-ins');
      return requireData(data, 'Check-In');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: supportKeys.checkIns.lists() }),
  });
}

/**
 * POST /check-ins/{id}/responses: one closed-choice answer, saved on the server at once.
 * The cached detail learns the answered id, so a later resume opens past it.
 */
export function useSaveCheckInAnswer(checkInId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { questionId: string; answerOptionId: string }) => {
      const { data } = await api.POST('/api/v0/check-ins/{id}/responses', {
        params: { path: { id: checkInId ?? '' } },
        body: { question_id: input.questionId, answer_option_id: input.answerOptionId },
      });
      return requireData(data, 'answer');
    },
    onSuccess: (_saved, input) =>
      queryClient.setQueryData<CheckInDetail>(
        supportKeys.checkIns.detail(checkInId ?? ''),
        (detail) =>
          detail && {
            ...detail,
            answered_question_ids: [
              ...new Set([...detail.answered_question_ids, input.questionId]),
            ],
          },
      ),
  });
}

/** POST /check-ins/{id}/commands/complete. Safe to repeat: the server replays. */
export function useCompleteCheckIn(checkInId: string | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST('/api/v0/check-ins/{id}/commands/complete', {
        params: { path: { id: checkInId ?? '' } },
      });
      return requireData(data, 'result');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: supportKeys.checkIns.lists() }),
  });
}

/** GET /consents. */
export function useConsents() {
  const token = useSessionToken();
  return useQuery({
    queryKey: supportKeys.consents.list(),
    enabled: token !== null,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/consents');
      return requireData(data, 'consents').consents;
    },
  });
}

/** Headers from the caller's `useIdempotencyKey()`: one key per user action. */
type KeyHeaders = Record<string, string>;

/** POST /consents/{id}/commands/revoke. */
export function useRevokeConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { consentGrantId: string; headers: KeyHeaders }) => {
      const { data } = await api.POST('/api/v0/consents/{id}/commands/revoke', {
        params: { path: { id: input.consentGrantId } },
        headers: input.headers,
      });
      return requireData(data, 'consent');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: supportKeys.consents.all }),
  });
}

/** POST /consents. */
export function useGrantConsent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { body: GrantConsentBody; headers: KeyHeaders }) => {
      const { data } = await api.POST('/api/v0/consents', {
        body: input.body,
        headers: input.headers,
      });
      return requireData(data, 'consent');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: supportKeys.consents.all }),
  });
}

/** GET /trusted-contacts. */
export function useTrustedContacts() {
  const token = useSessionToken();
  return useQuery({
    queryKey: supportKeys.trustedContacts.list(),
    enabled: token !== null,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/trusted-contacts');
      return requireData(data, 'trusted contacts').trusted_contacts;
    },
  });
}

/** POST /trusted-contacts. */
export function useInviteTrustedContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      relationshipLabel: string;
      email: string;
      headers: KeyHeaders;
    }) => {
      const { data } = await api.POST('/api/v0/trusted-contacts', {
        body: { relationship_label: input.relationshipLabel, invite_email: input.email },
        headers: input.headers,
      });
      return requireData(data, 'invitation');
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: supportKeys.trustedContacts.all }),
  });
}

/**
 * Remove a trusted contact. An ACTIVE RED-alert grant to them is revoked first (its own key),
 * then the contact is removed. Both lists are refreshed even after a partial failure, so a
 * retry sees the grant already revoked.
 */
export function useRemoveTrustedContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      trustedContactId: string;
      redGrantId: string | undefined;
      revokeHeaders: KeyHeaders;
      removeHeaders: KeyHeaders;
    }) => {
      if (input.redGrantId !== undefined) {
        await api.POST('/api/v0/consents/{id}/commands/revoke', {
          params: { path: { id: input.redGrantId } },
          headers: input.revokeHeaders,
        });
      }
      const { data } = await api.POST('/api/v0/trusted-contacts/{id}/commands/remove', {
        params: { path: { id: input.trustedContactId } },
        headers: input.removeHeaders,
      });
      return requireData(data, 'trusted contact');
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: supportKeys.consents.all }),
        queryClient.invalidateQueries({ queryKey: supportKeys.trustedContacts.all }),
      ]),
  });
}

/** The inbox's page size from before the server's default dropped to 20 (API.md §5). */
const NOTIFICATION_LIMIT = 50;

/** GET /notifications, the latest NOTIFICATION_LIMIT. The screen sorts newest first. */
export function useNotifications() {
  const token = useSessionToken();
  return useQuery({
    queryKey: queryKeys.notifications.list(),
    enabled: token !== null,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/notifications', {
        params: { query: { limit: NOTIFICATION_LIMIT } },
      });
      return requireData(data, 'notifications').notifications;
    },
  });
}
