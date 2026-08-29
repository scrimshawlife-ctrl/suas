import { describe, expect, it } from 'vitest';
import {
  DisabledVeteranVerificationAdapter,
  normalizeVaVeteranStatus,
  VeteranVerificationDisabledError,
} from '../../src/identity/index.js';

describe('D-035 proposed Veteran verification contract', () => {
  it('normalizes confirmed Title 38 status to VERIFIED', () => {
    expect(
      normalizeVaVeteranStatus({
        veteranStatus: 'confirmed',
        sourceContractVersion: 'va-veteran-verification-v2',
      }),
    ).toEqual({
      status: 'VERIFIED',
      sourceContractVersion: 'va-veteran-verification-v2',
    });
  });

  it.each(['PERSON_NOT_FOUND', 'NOT_TITLE_38', 'MORE_RESEARCH_REQUIRED'] as const)(
    'preserves %s as NOT_CONFIRMED without inferring no service',
    (reason) => {
      expect(
        normalizeVaVeteranStatus({
          veteranStatus: 'not confirmed',
          notConfirmedReason: reason,
          sourceContractVersion: 'va-veteran-verification-v2',
        }),
      ).toEqual({
        status: 'NOT_CONFIRMED',
        notConfirmedReason: reason,
        sourceContractVersion: 'va-veteran-verification-v2',
      });
    },
  );

  it('normalizes provider/source ERROR to UNAVAILABLE so fallback can remain available', () => {
    expect(
      normalizeVaVeteranStatus({
        veteranStatus: 'not confirmed',
        notConfirmedReason: 'ERROR',
        sourceContractVersion: 'va-veteran-verification-v2',
      }),
    ).toEqual({
      status: 'UNAVAILABLE',
      notConfirmedReason: 'ERROR',
      sourceContractVersion: 'va-veteran-verification-v2',
    });
  });

  it('does not emit an undefined reason when the source supplies none', () => {
    expect(
      normalizeVaVeteranStatus({
        veteranStatus: 'not confirmed',
        sourceContractVersion: 'va-veteran-verification-v2',
      }),
    ).toEqual({
      status: 'NOT_CONFIRMED',
      sourceContractVersion: 'va-veteran-verification-v2',
    });
  });

  it('fails closed while the provider adapter is disabled', async () => {
    const adapter = new DisabledVeteranVerificationAdapter();

    await expect(
      adapter.verifyVeteranStatus({
        veteranId: 'veteran-fixture-001',
        authorizationCode: 'fixture-code',
        redirectUri: 'https://example.invalid/auth/va/callback',
      }),
    ).rejects.toBeInstanceOf(VeteranVerificationDisabledError);
  });
});
