export const VETERAN_VERIFICATION_METHODS = [
  'VA_VETERAN_STATUS',
  'SELF_ATTESTATION',
  'MANUAL_REVIEW',
] as const;

export type VeteranVerificationMethod = (typeof VETERAN_VERIFICATION_METHODS)[number];

export const VETERAN_VERIFICATION_STATUSES = [
  'VERIFIED',
  'NOT_CONFIRMED',
  'PENDING',
  'UNAVAILABLE',
  'REVOKED',
] as const;

export type VeteranVerificationStatus = (typeof VETERAN_VERIFICATION_STATUSES)[number];

export const VA_NOT_CONFIRMED_REASONS = [
  'PERSON_NOT_FOUND',
  'NOT_TITLE_38',
  'MORE_RESEARCH_REQUIRED',
  'ERROR',
] as const;

export type VaNotConfirmedReason = (typeof VA_NOT_CONFIRMED_REASONS)[number];

export interface VeteranVerification {
  id: string;
  veteranId: string;
  method: VeteranVerificationMethod;
  status: VeteranVerificationStatus;
  source: 'VA' | 'SUAS';
  sourceContractVersion: string;
  verifiedAt?: string;
  notConfirmedReason?: VaNotConfirmedReason;
  consentGrantId?: string;
  auditEventId: string;
}

export interface VeteranVerificationResult {
  status: 'VERIFIED' | 'NOT_CONFIRMED' | 'UNAVAILABLE';
  notConfirmedReason?: VaNotConfirmedReason;
  sourceContractVersion: string;
}

/**
 * Provider-neutral boundary for Veteran-status verification.
 *
 * D-035 is not release-settled. Production wiring must remain disabled until
 * the specs explicitly authorize the adapter and its privacy/security gates.
 */
export interface VeteranVerificationPort {
  verifyVeteranStatus(input: {
    veteranId: string;
    authorizationCode: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<VeteranVerificationResult>;
}

export class VeteranVerificationDisabledError extends Error {
  constructor() {
    super('Veteran verification adapter is disabled');
    this.name = 'VeteranVerificationDisabledError';
  }
}

export class DisabledVeteranVerificationAdapter implements VeteranVerificationPort {
  async verifyVeteranStatus(): Promise<VeteranVerificationResult> {
    throw new VeteranVerificationDisabledError();
  }
}

/**
 * Normalize only the Title 38 status fields needed by SUAS onboarding.
 * Raw VA payloads must remain adapter-local and must not become domain state.
 */
export function normalizeVaVeteranStatus(input: {
  veteranStatus: 'confirmed' | 'not confirmed';
  notConfirmedReason?: VaNotConfirmedReason;
  sourceContractVersion: string;
}): VeteranVerificationResult {
  if (input.veteranStatus === 'confirmed') {
    return {
      status: 'VERIFIED',
      sourceContractVersion: input.sourceContractVersion,
    };
  }

  return {
    status: input.notConfirmedReason === 'ERROR' ? 'UNAVAILABLE' : 'NOT_CONFIRMED',
    notConfirmedReason: input.notConfirmedReason,
    sourceContractVersion: input.sourceContractVersion,
  };
}
