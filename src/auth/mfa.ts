/**
 * Multi-factor authentication port.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §4 — responders, org admins, and SUAS admins "complete MFA
 *   before privileged session elevation"; the factor type is "selected later; no
 *   vendor lock in the domain contract".
 * - SUAS-specs SECURITY.md §2 — MFA required for Responder, Org-admin,
 *   SUAS-admin.
 * - SUAS-specs ENVIRONMENT.md §2 — LOCAL/TEST/STAGING forbid real external
 *   effects; STAGING exercises fake adapters and failure drills.
 *
 * No factor vendor is selected here. The port is the contract; the only
 * implementation is a test factor that produces no external effect.
 */

import { randomUUID } from 'node:crypto';
import type { EnvironmentClass, SuasConfig } from '../config/index.js';
import { CHALLENGE_TTL_SECONDS } from './constants.js';

export type MfaFactorType = 'TEST_FACTOR';

export class MfaRequiredError extends Error {
  readonly code = 'MFA_REQUIRED';
  readonly httpStatus = 403;

  constructor(action: string) {
    super(`${action} requires an MFA-elevated session (SUAS-specs AUTH.md §4; SECURITY.md §2).`);
    this.name = 'MfaRequiredError';
  }
}

export class MfaUnavailableError extends Error {
  readonly code = 'MFA_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(environment: EnvironmentClass) {
    super(
      `No MFA factor is available for ${environment}. The MVP factor type is selected by a ` +
        `later released decision (SUAS-specs AUTH.md §4), and a test factor must never carry ` +
        `production elevation.`,
    );
    this.name = 'MfaUnavailableError';
  }
}

export interface MfaChallenge {
  readonly challengeId: string;
  readonly factorType: MfaFactorType;
}

/** The signed-in session a factor challenge belongs to. Only it may answer the challenge. */
export interface MfaBinding {
  readonly userId: string;
  readonly sessionId: string;
}

export interface MfaPort {
  readonly factorType: MfaFactorType;
  readonly implementation: string;
  /** Begin a factor challenge for the caller's session. */
  begin(binding: MfaBinding): Promise<MfaChallenge>;
  /**
   * Verify a factor response from the session that began the challenge. A true result
   * authorizes elevation of that session, nothing more.
   */
  verify(challengeId: string, response: string, binding: MfaBinding): Promise<boolean>;
}

/**
 * Deterministic test factor for the synthetic environment classes.
 *
 * It proves the elevation boundary — that privileged work is refused until a
 * factor is verified — without standing in for a real second factor: the answer is
 * still derived from the challenge id because there is no channel to deliver a code
 * on, which is only acceptable because these environments forbid real users.
 * Challenges are random, expire, and answer only the session that began them
 * (AUTH.md §3, §4). They live in this process, so one instance must serve both calls.
 */
export class TestMfaFactor implements MfaPort {
  readonly factorType: MfaFactorType = 'TEST_FACTOR';
  readonly implementation = 'test-factor';

  private readonly pending = new Map<string, MfaBinding & { expiresAt: number }>();

  begin(binding: MfaBinding): Promise<MfaChallenge> {
    this.dropExpired();
    const challengeId = `mfa-test-${randomUUID()}`;
    this.pending.set(challengeId, {
      userId: binding.userId,
      sessionId: binding.sessionId,
      expiresAt: Date.now() + CHALLENGE_TTL_SECONDS.value * 1000,
    });
    return Promise.resolve({ challengeId, factorType: this.factorType });
  }

  verify(challengeId: string, response: string, binding: MfaBinding): Promise<boolean> {
    const entry = this.pending.get(challengeId);
    // Another session's challenge is refused without consuming it, so it cannot be burned.
    if (
      entry === undefined ||
      entry.userId !== binding.userId ||
      entry.sessionId !== binding.sessionId
    ) {
      return Promise.resolve(false);
    }
    // Single-use, mirroring the challenge contract of AUTH.md §3.
    this.pending.delete(challengeId);
    if (entry.expiresAt <= Date.now()) return Promise.resolve(false);
    return Promise.resolve(response === this.expectedResponse(challengeId));
  }

  /** Test-only: the response this factor will accept. */
  expectedResponse(challengeId: string): string {
    return `ok-${challengeId}`;
  }

  private dropExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(id);
    }
  }
}

/**
 * Select the MFA implementation for this environment.
 *
 * PRODUCTION fails closed: elevating a real privileged session on a test factor
 * would be a security control in name only. LOCAL, TEST, and STAGING receive the
 * test factor, which is what lets STAGING run privileged-path drills.
 */
export function createMfaPort(config: SuasConfig): MfaPort {
  if (config.environment === 'PRODUCTION') {
    throw new MfaUnavailableError(config.environment);
  }
  return new TestMfaFactor();
}
