/**
 * Veteran ID verification capability port: an `ID_SCAN_SELFIE` check.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 (every Veteran passes ID scan + selfie
 * before requesting help), §4.3 F2 (a verification port with a fake adapter until
 * the provider is chosen), §7 (the fake must not run in production), §8 item 2
 * (provider not chosen). AGENTS.md rule 6.
 *
 * Statuses reuse the vocabulary of `veteran_verifications`
 * (migrations/0014; `VeteranVerificationStatus`) so a result maps onto that
 * record without translation. No provider SDK, payload, score, or image data
 * crosses this port: only the status. How a person captures the ID and selfie
 * is provider-specific and is not part of this port yet.
 *
 * The port never throws for provider failures. They come back as `UNAVAILABLE`.
 * suas-specs #72 R9.1 (proposal) moves the request gate to VA Veteran Confirmation, so
 * this port no longer feeds the gate; its config is still validated at startup.
 */

import type { SuasConfig } from '../config/index.js';
import { FakeIdVerification } from './fake-id-verification.js';
import type { VeteranVerificationStatus } from './veteran-verification.js';

export const ID_CHECK_METHOD = 'ID_SCAN_SELFIE' as const;

/** The subset of verification statuses a check can report. REVOKED is a SUAS act. */
export type IdCheckStatus = Extract<
  VeteranVerificationStatus,
  'PENDING' | 'VERIFIED' | 'NOT_CONFIRMED' | 'UNAVAILABLE'
>;

export interface StartIdCheckInput {
  /** The SUAS user being verified. */
  readonly subjectId: string;
  /** Stable identity so a retried start does not open a second check (rule 10). */
  readonly idempotencyKey: string;
}

export type IdCheckStart =
  { readonly status: 'PENDING'; readonly checkId: string } | { readonly status: 'UNAVAILABLE' };

export interface IdCheckOutcome {
  readonly status: IdCheckStatus;
}

export interface IdVerificationPort {
  readonly implementation: string;
  startCheck(input: StartIdCheckInput): Promise<IdCheckStart>;
  /** An unknown check id reads as `UNAVAILABLE`. */
  readOutcome(checkId: string): Promise<IdCheckOutcome>;
}

/**
 * ID verification for this configuration, or undefined when disabled so callers
 * report the gate unavailable. Fake auto-verify is LOCAL and TEST only. STAGING
 * and PRODUCTION fail closed even if a caller builds a config the startup
 * schema would already have refused (D-052).
 */
export function createIdVerificationPort(config: SuasConfig): IdVerificationPort | undefined {
  if (config.idVerification.mode === 'fake') {
    if (config.environment !== 'LOCAL' && config.environment !== 'TEST') {
      throw new Error(
        'Fake ID verification is refused outside LOCAL and TEST. STAGING and PRODUCTION fail closed.',
      );
    }
    return new FakeIdVerification({ initialStatus: 'VERIFIED' });
  }
  return undefined;
}
