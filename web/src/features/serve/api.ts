import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useKeyedIdempotency } from '../../api/idempotency';
import { infiniteServiceRequestsKey } from '../../api/service-requests';
import { queryKeys, resourceKeys } from '../../api/keys';
import { cursorPages, useSignedInInfiniteQuery, useSignedInQuery } from '../../api/queries';
import { requireData } from '../../api/require-data';
import { latestAlerts } from './alerts';
import type { Schemas } from '../../api/types';
import { BOARD_REFRESH_MS } from '../../app/poll-intervals';
import type { ContactSave, NextStep } from './case-logic';

/** Serve-only resources. They live here because the shared key file is not ours to edit. */
const caseKeys = {
  /** GET /cases/{id}: the status the Wrap up card works from. */
  cases: resourceKeys('cases'),
  contactAttempts: resourceKeys('case-contact-attempts'),
  serviceRequests: resourceKeys('case-service-requests'),
};

const BOARD_PAGE_SIZE = 20;

/** GET /service-requests?ownership=open, paged by `next_cursor`. */
export function useOpenRequests() {
  return useSignedInInfiniteQuery({
    ...cursorPages({
      queryKey: queryKeys.serviceRequests.list({ ownership: 'open', board: true }),
      fetchPage: async (page) => {
        const { data } = await api.GET('/api/v0/service-requests', {
          params: { query: { ownership: 'open', limit: BOARD_PAGE_SIZE, ...page } },
        });
        return requireData(data, 'requests');
      },
    }),
    refetchInterval: BOARD_REFRESH_MS,
  });
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
  return useSignedInQuery({
    queryKey: queryKeys.notifications.list({ surface: 'serve-alerts' }),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/notifications', {
        params: { query: { limit: ALERT_SOURCE_LIMIT } },
      });
      return latestAlerts(requireData(data, 'alerts').notifications);
    },
    refetchInterval: BOARD_REFRESH_MS,
  });
}

/** The case page loads each case list 50 at a time, paged by `next_cursor`. */
const CASE_LIST_LIMIT = 50;

/** GET /cases/{caseId}/contact-attempts: the accepter only (403 for anyone else). */
export function useContactAttempts(caseId: string | undefined) {
  return useSignedInInfiniteQuery({
    ...cursorPages({
      queryKey: caseKeys.contactAttempts.list({ caseId }),
      fetchPage: async (page) => {
        const { data } = await api.GET('/api/v0/cases/{caseId}/contact-attempts', {
          params: { path: { caseId: caseId ?? '' }, query: { limit: CASE_LIST_LIMIT, ...page } },
        });
        return requireData(data, 'contact attempts');
      },
    }),
    enabled: caseId !== undefined,
  });
}

/** GET /cases/{caseId}/service-requests. */
export function useCaseServiceRequests(caseId: string | undefined) {
  return useSignedInInfiniteQuery({
    ...cursorPages({
      queryKey: caseKeys.serviceRequests.list({ caseId }),
      fetchPage: async (page) => {
        const { data } = await api.GET('/api/v0/cases/{caseId}/service-requests', {
          params: { path: { caseId: caseId ?? '' }, query: { limit: CASE_LIST_LIMIT, ...page } },
        });
        return requireData(data, 'case requests');
      },
    }),
    enabled: caseId !== undefined,
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

/**
 * A helper's paged list without one request they no longer hold. Every page carries the
 * all-pages counts, so each "helping now" drops by one when any page held it.
 */
function withoutHeld<T extends HeldList>(
  data: InfiniteData<T>,
  serviceRequestId: string,
): InfiniteData<T> {
  const isIt = (item: { service_request_id: string }) =>
    item.service_request_id === serviceRequestId;
  if (!data.pages.some((page) => page.service_requests.some(isIt))) return data;
  return {
    ...data,
    pages: data.pages.map((page) => {
      const counts = page.counts && {
        ...page.counts,
        helping_now: Math.max(0, page.counts.helping_now - 1),
      };
      return {
        ...page,
        service_requests: page.service_requests.filter((item) => !isIt(item)),
        ...(counts ? { counts } : {}),
      };
    }),
  };
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
      // Drop it from the board's cached "mine" pages at once, or its row renders and re-reads it.
      queryClient.setQueryData<InfiniteData<HeldList>>(
        infiniteServiceRequestsKey('mine'),
        (data) => (data === undefined ? data : withoutHeld(data, serviceRequestId)),
      );
      const stale = { refetchType: 'none' } as const;
      void queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all, ...stale });
      void queryClient.invalidateQueries({ queryKey: caseKeys.serviceRequests.all, ...stale });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chatThreads, ...stale });
    },
  });
}

/** GET /cases/{id}: the Case status the Wrap up card works from (owner or holder only). */
export function useSupportCase(caseId: string) {
  return useSignedInQuery({
    queryKey: caseKeys.cases.detail(caseId),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/cases/{id}', { params: { path: { id: caseId } } });
      return requireData(data, 'case');
    },
  });
}

/** The four Settlement parts, each the helper's typed text and nothing else. */
export type SettlementText = Record<'requested' | 'occurred' | 'fulfilled' | 'unresolved', string>;

export interface WrapUp {
  status: Schemas['CaseStatus'];
  settlement: SettlementText;
}

/**
 * Resolves the Case with a Settlement, activating an ASSIGNED Case first (RESOLVE needs ACTIVE).
 * Both keys outlive a failure, so a retry replays a finished activate instead of a 409.
 */
export function useWrapUpCase(caseId: string) {
  const queryClient = useQueryClient();
  const keys = useKeyedIdempotency();
  return useMutation({
    mutationFn: async ({ status, settlement }: WrapUp) => {
      const params = { path: { id: caseId } };
      if (status === 'ASSIGNED') {
        await api.POST('/api/v0/cases/{id}/commands/activate', {
          params,
          body: {},
          headers: keys.headers('activate'),
        });
      }
      await api.POST('/api/v0/cases/{id}/commands/resolve', {
        params,
        body: {
          requested: { text: settlement.requested },
          occurred: { text: settlement.occurred },
          fulfilled: { text: settlement.fulfilled },
          unresolved: { text: settlement.unresolved },
        },
        headers: keys.headers(JSON.stringify(settlement)),
      });
    },
    onSuccess: (_data, { settlement }) => {
      keys.renew('activate');
      keys.renew(JSON.stringify(settlement));
    },
    // A refusal (stale state, a request still open) means the case moved, so re-read both.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: caseKeys.cases.detail(caseId) }),
        queryClient.invalidateQueries({ queryKey: caseKeys.serviceRequests.all }),
      ]),
  });
}

/** POST close on a RESOLVED Case. It ends every helper's standing here (CASES.md, R11.1). */
export function useCloseCase(caseId: string) {
  const queryClient = useQueryClient();
  const keys = useKeyedIdempotency();
  return useMutation({
    mutationFn: async () => {
      await api.POST('/api/v0/cases/{id}/commands/close', {
        params: { path: { id: caseId } },
        body: {},
        headers: keys.headers('close'),
      });
    },
    // As after a release: mark stale without re-reading, or the mounted case re-reads into a 404.
    onSuccess: () => {
      keys.renew('close');
      const stale = { refetchType: 'none' } as const;
      for (const queryKey of [
        queryKeys.serviceRequests.all,
        caseKeys.cases.all,
        queryKeys.chatThreads,
        caseKeys.serviceRequests.all,
        caseKeys.contactAttempts.all,
      ]) {
        void queryClient.invalidateQueries({ queryKey, ...stale });
      }
    },
  });
}
