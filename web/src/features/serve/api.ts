import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { api } from '../../api/client';
import { retryServerErrors } from '../../api/errors';
import { serviceRequestsQueryOptions } from '../../api/service-requests';
import { queryKeys, resourceKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import { useSessionToken } from '../../api/token-store';
import { latestAlerts } from './alerts';
import type { ContactSave, NextStep } from './case-logic';

/** Serve-only resources. They live here because the shared key file is not ours to edit. */
const caseKeys = {
  contactAttempts: resourceKeys('case-contact-attempts'),
  serviceRequests: resourceKeys('case-service-requests'),
};

const BOARD_PAGE_SIZE = 20;
/** The open board refreshes about every 30 seconds so taken requests drop off. */
const BOARD_REFRESH_MS = 30_000;

/** GET /service-requests?ownership=open, paged by `next_cursor`. */
export function useOpenRequests() {
  const token = useSessionToken();
  return useInfiniteQuery({
    queryKey: queryKeys.serviceRequests.list({ ownership: 'open', board: true }),
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET('/api/v0/service-requests', {
        params: {
          query: {
            ownership: 'open',
            limit: BOARD_PAGE_SIZE,
            ...(pageParam === undefined ? {} : { cursor: pageParam }),
          },
        },
      });
      return requireData(data, 'requests');
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    refetchInterval: BOARD_REFRESH_MS,
    retry: retryServerErrors,
    enabled: token !== null,
  });
}

/** One Idempotency-Key per user action, kept per target so a retry of the same action reuses it. */
function useKeyedIdempotency() {
  const keys = useRef(new Map<string, string>());
  return {
    headers(target: string): Record<string, string> {
      let key = keys.current.get(target);
      if (key === undefined) {
        key = crypto.randomUUID();
        keys.current.set(target, key);
      }
      return { 'Idempotency-Key': key };
    },
    renew(target: string): void {
      keys.current.delete(target);
    },
  };
}

/** POST /service-requests/{id}/accept. First accept wins; the loser gets 409 ALREADY_CLAIMED. */
export function useAcceptRequest() {
  const queryClient = useQueryClient();
  const keys = useKeyedIdempotency();
  return useMutation({
    mutationFn: async (serviceRequestId: string) => {
      const { data } = await api.POST('/api/v0/service-requests/{id}/accept', {
        params: { path: { id: serviceRequestId } },
        headers: keys.headers(serviceRequestId),
      });
      return requireData(data, 'result');
    },
    onSuccess: (_data, serviceRequestId) => {
      keys.renew(serviceRequestId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all });
    },
  });
}

/** Notifications the Alerts card picks from, as many as before the server's default dropped to 20. */
const ALERT_SOURCE_LIMIT = 50;

/** GET /notifications for the Alerts card: the latest few, in plain words. */
export function useAlerts() {
  const token = useSessionToken();
  return useQuery({
    queryKey: queryKeys.notifications.list({ surface: 'serve-alerts' }),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/notifications', {
        params: { query: { limit: ALERT_SOURCE_LIMIT } },
      });
      return latestAlerts(requireData(data, 'alerts').notifications);
    },
    refetchInterval: BOARD_REFRESH_MS,
    retry: retryServerErrors,
    enabled: token !== null,
  });
}

/** The case page shows one page of each case list: 50, as many as before the server paged them. */
const CASE_LIST_LIMIT = 50;

/** GET /cases/{caseId}/contact-attempts: the accepter only (403 for anyone else). */
export function useContactAttempts(caseId: string | undefined) {
  const token = useSessionToken();
  return useQuery({
    queryKey: caseKeys.contactAttempts.list({ caseId }),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/cases/{caseId}/contact-attempts', {
        params: { path: { caseId: caseId ?? '' }, query: { limit: CASE_LIST_LIMIT } },
      });
      return requireData(data, 'contact attempts').contact_attempts;
    },
    retry: retryServerErrors,
    enabled: token !== null && caseId !== undefined,
  });
}

/** GET /cases/{caseId}/service-requests. */
export function useCaseServiceRequests(caseId: string | undefined) {
  const token = useSessionToken();
  return useQuery({
    queryKey: caseKeys.serviceRequests.list({ caseId }),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/cases/{caseId}/service-requests', {
        params: { path: { caseId: caseId ?? '' }, query: { limit: CASE_LIST_LIMIT } },
      });
      return requireData(data, 'case requests').service_requests;
    },
    retry: retryServerErrors,
    enabled: token !== null && caseId !== undefined,
  });
}

/** A retry of the same attempt reuses its key; a different attempt gets its own. */
function saveTarget(save: ContactSave): string {
  return `${save.route}:${save.body.channel}:${save.body.outcome}`;
}

/** Saves one contact attempt through the route its outcome belongs to. */
export function useSaveContact(caseId: string) {
  const queryClient = useQueryClient();
  const keys = useKeyedIdempotency();
  return useMutation({
    mutationFn: async (save: ContactSave) => {
      const options = { params: { path: { caseId } }, headers: keys.headers(saveTarget(save)) };
      if (save.route === 'log-contact-attempt') {
        await api.POST('/api/v0/cases/{caseId}/commands/log-contact-attempt', {
          ...options,
          body: save.body,
        });
      } else {
        await api.POST('/api/v0/cases/{caseId}/commands/complete-contact', {
          ...options,
          body: save.body,
        });
      }
    },
    onSuccess: (_data, save) => {
      keys.renew(saveTarget(save));
      void queryClient.invalidateQueries({ queryKey: caseKeys.contactAttempts.all });
    },
  });
}

/** Runs the accepter's next progress command (START, FULFILL, ...) on one request. */
export function useRunStep(serviceRequestId: string) {
  const queryClient = useQueryClient();
  const keys = useKeyedIdempotency();
  return useMutation({
    mutationFn: async (step: NextStep) => {
      await api.POST('/api/v0/service-requests/{id}/commands/{command}', {
        params: { path: { id: serviceRequestId, command: step.command } },
        body: {},
        headers: keys.headers(step.command),
      });
    },
    onSuccess: (_data, step) => keys.renew(step.command),
    // A rejected step usually means the status moved under us, so always re-read.
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all }),
        queryClient.invalidateQueries({ queryKey: caseKeys.serviceRequests.all }),
      ]);
    },
  });
}

interface HeldList {
  service_requests: { service_request_id: string }[];
  counts?: { helping_now: number };
}

/** A helper's list without one request they no longer hold, its "helping now" count to match. */
function withoutHeld<T extends HeldList>(list: T, serviceRequestId: string): T {
  const kept = list.service_requests.filter((item) => item.service_request_id !== serviceRequestId);
  if (kept.length === list.service_requests.length) return list;
  const counts = list.counts && {
    ...list.counts,
    helping_now: Math.max(0, list.counts.helping_now - 1),
  };
  return { ...list, service_requests: kept, ...(counts ? { counts } : {}) };
}

/**
 * POST the RELEASE command with the helper's reason. The key follows the reason, so a retry
 * of the same text reuses it and an edited reason (a different body) gets a fresh one.
 */
export function useReleaseRequest(serviceRequestId: string) {
  const queryClient = useQueryClient();
  const keys = useKeyedIdempotency();
  return useMutation({
    mutationFn: async (reason: string) => {
      await api.POST('/api/v0/service-requests/{id}/commands/{command}', {
        params: { path: { id: serviceRequestId, command: 'RELEASE' } },
        body: { reason },
        headers: keys.headers(reason),
      });
    },
    // Mark stale without re-reading now: this helper just lost the request, so the mounted case
    // would re-read into a 404. The Serve board the caller navigates to re-reads on mount.
    onSuccess: (_data, reason) => {
      keys.renew(reason);
      // Drop it from the cached "mine" list at once, or the board renders its row and re-reads it.
      queryClient.setQueryData(
        serviceRequestsQueryOptions({ ownership: 'mine' }).queryKey,
        (list) => (list === undefined ? list : withoutHeld(list, serviceRequestId)),
      );
      const stale = { refetchType: 'none' } as const;
      void queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all, ...stale });
      void queryClient.invalidateQueries({ queryKey: caseKeys.serviceRequests.all, ...stale });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatThreads, ...stale });
    },
  });
}
