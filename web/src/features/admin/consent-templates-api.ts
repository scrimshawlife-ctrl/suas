import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useCommandKey } from '../../api/idempotency';
import { queryKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import type { Schemas } from '../../api/types';

export type ConsentTemplateVersion = Schemas['ConsentTemplateVersion'];

/** Every consent template version, newest version of each key first (R9.3). */
export function useConsentTemplates() {
  return useQuery({
    queryKey: queryKeys.adminConsentTemplates.list(),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/admin/consent-templates');
      return requireData(data, 'consent templates').templates;
    },
  });
}

/** A new DRAFT version of a template key; the server numbers it. */
export function useCreateConsentTemplate() {
  const queryClient = useQueryClient();
  const key = useCommandKey();
  return useMutation({
    mutationFn: async (body: { template_key: string; body: string }) => {
      const { data } = await api.POST('/api/v0/admin/consent-templates', {
        body,
        headers: key.headers(body),
      });
      return requireData(data, 'consent template');
    },
    onSuccess: (_template, body) => {
      key.settle(body);
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminConsentTemplates.all });
    },
    onError: (error, body) => key.settle(body, error),
  });
}

/**
 * Publish a DRAFT version; the key's earlier published version is superseded. No
 * Idempotency-Key: the route takes none, and a repeat finds no DRAFT and answers 409.
 */
export function usePublishConsentTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (version: string) => {
      const { data } = await api.POST(
        '/api/v0/admin/consent-templates/{version}/commands/publish',
        {
          params: { path: { version } },
        },
      );
      return requireData(data, 'published template');
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.adminConsentTemplates.all }),
  });
}
