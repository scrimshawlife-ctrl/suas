import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { retryServerErrors } from '../../api/errors';
import { queryKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import { useSessionToken } from '../../api/token-store';
import type { Schemas } from '../../api/types';
import { blobToBase64 } from './licence-image';
import type { LicencePhotos } from './LicenceForm';
import { LICENCE_NOTICE_VERSION } from './LicenceNotice';
import { licencePollInterval } from './licence-status';

export type LicenceVerification = Schemas['LicenceVerification'];
export type LicenceReviewView = Schemas['LicenceReviewView'];

/**
 * GET /veterans/me/verification/licence (suas-specs #73 R10.1 proposal): whether the licence
 * path is offered, and the newest review. Polls while the review is reading or with admins.
 */
export function useLicenceReview(enabled = true) {
  const token = useSessionToken();
  return useQuery({
    queryKey: queryKeys.licence,
    enabled: enabled && token !== null,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/veterans/me/verification/licence');
      return requireData(data, 'licence review');
    },
    refetchInterval: (query) => licencePollInterval(query.state.data?.review?.status),
    retry: retryServerErrors,
  });
}

/** A new review, or a dispute of the ALREADY_USED decline with this id (L7.3). */
export interface LicenceSend {
  photos: LicencePhotos;
  disputeOf: string | null;
}

/**
 * POST /veterans/me/verification/licence, or .../{review_id}/commands/dispute, with the notice
 * version and the three JPEGs as base64. The route takes no Idempotency-Key: a second send while
 * one is open gets 409 LICENCE_REVIEW_OPEN, and the page adds the single-flight guard.
 */
export function useSubmitLicence() {
  const queryClient = useQueryClient();
  return useMutation({
    // The photos are in the variables; gone from the mutation cache once the page resets it.
    gcTime: 0,
    mutationFn: async ({ photos, disputeOf }: LicenceSend) => {
      const [front, back, selfie] = await Promise.all(
        [photos.front, photos.back, photos.selfie].map(blobToBase64),
      );
      const image = (data_base64: string | undefined) => ({
        content_type: 'image/jpeg' as const,
        data_base64: data_base64 ?? '',
      });
      const body = {
        notice_version: LICENCE_NOTICE_VERSION,
        front: image(front),
        back: image(back),
        selfie: image(selfie),
      };
      const { data } =
        disputeOf === null
          ? await api.POST('/api/v0/veterans/me/verification/licence', { body })
          : await api.POST(
              '/api/v0/veterans/me/verification/licence/{review_id}/commands/dispute',
              { params: { path: { review_id: disputeOf } }, body },
            );
      return requireData(data, 'licence review');
    },
    onSuccess: (review) =>
      queryClient.setQueryData<LicenceVerification>(queryKeys.licence, (current) =>
        current === undefined ? current : { ...current, review },
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.licence }),
  });
}
