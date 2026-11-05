/**
 * Deterministic fake for the ID verification port (LOCAL and TEST only).
 *
 * Config and the port factory refuse it in STAGING and PRODUCTION (D-052).
 * Tests drive outcomes
 * with `resolve`; the constructor sets the status a new check starts with.
 */

import type {
  IdCheckOutcome,
  IdCheckStart,
  IdCheckStatus,
  IdVerificationPort,
  StartIdCheckInput,
} from './id-verification.js';

export interface FakeIdVerificationOptions {
  /** Status a new check reports. Defaults to PENDING. */
  readonly initialStatus?: Exclude<IdCheckStatus, 'UNAVAILABLE'>;
}

export class FakeIdVerification implements IdVerificationPort {
  readonly implementation = 'fake-id-verification';

  private readonly checks = new Map<string, IdCheckStatus>();
  private readonly checkIdByKey = new Map<string, string>();
  private readonly initialStatus: IdCheckStatus;
  private available = true;

  constructor(options: FakeIdVerificationOptions = {}) {
    this.initialStatus = options.initialStatus ?? 'PENDING';
  }

  startCheck(input: StartIdCheckInput): Promise<IdCheckStart> {
    if (!this.available) return Promise.resolve({ status: 'UNAVAILABLE' });
    let checkId = this.checkIdByKey.get(input.idempotencyKey);
    if (checkId === undefined) {
      checkId = `fake-id-check-${this.checks.size + 1}`;
      this.checkIdByKey.set(input.idempotencyKey, checkId);
      this.checks.set(checkId, this.initialStatus);
    }
    return Promise.resolve({ status: 'PENDING', checkId });
  }

  readOutcome(checkId: string): Promise<IdCheckOutcome> {
    if (!this.available) return Promise.resolve({ status: 'UNAVAILABLE' });
    return Promise.resolve({ status: this.checks.get(checkId) ?? 'UNAVAILABLE' });
  }

  /** Test-only: set the outcome a later `readOutcome` reports. */
  resolve(checkId: string, status: IdCheckStatus): void {
    this.checks.set(checkId, status);
  }

  /** Test-only: simulate a provider outage. */
  setAvailable(available: boolean): void {
    this.available = available;
  }
}
