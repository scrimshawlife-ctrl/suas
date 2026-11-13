import { isApiError } from '../../api/errors';
import type { StatusKind } from '../../components/StatusChip';

/**
 * The words the licence reviewer sees (suas-specs #73 R10.1 proposal, SCRY_LICENCE_FALLBACK.md
 * L5). Codes never reach the page; field values only appear in the review's reading section.
 */

export const STATUS_CHIPS: Readonly<Record<string, { kind: StatusKind; text: string }>> = {
  READING: { kind: 'wait', text: 'Reading' },
  UNREADABLE: { kind: 'off', text: 'Unreadable' },
  AWAITING_REVIEW: { kind: 'info', text: 'To review' },
  AWAITING_CONFIRMATION: { kind: 'info', text: 'To confirm' },
  APPROVED: { kind: 'ok', text: 'Approved' },
  DECLINED: { kind: 'off', text: 'Declined' },
  REVOKED: { kind: 'off', text: 'Revoked' },
};

export function statusChip(status: string): { kind: StatusKind; text: string } {
  return STATUS_CHIPS[status] ?? { kind: 'off', text: status };
}

/** The reader's fields in reading order (§2.1); no licence number or birth date. */
export const LICENCE_FIELDS = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'issuing_state', label: 'Issuing state' },
  { key: 'issue_date', label: 'Issue date' },
  { key: 'expiry_date', label: 'Expiry date' },
] as const;

export function sourceLabel(source: string | null): string {
  if (source === 'barcode') return 'From the barcode';
  if (source === 'front') return 'From the printed front';
  return 'Not read';
}

export function designationText(mark: string | null): string {
  if (mark === 'yes') return 'Veteran';
  if (mark === 'no') return 'No Veteran designation';
  return 'Not read';
}

/** L5.3: "consistency checks: these do not show the card is genuine". */
export const CONSISTENCY_CHECKS = [
  { key: 'not_expired', label: 'Not expired' },
  { key: 'issued_before_expiry', label: 'Issued before it expires' },
  { key: 'plausible_age', label: 'Plausible age' },
  {
    key: 'veteran_designation_agrees',
    label: 'Barcode and front agree on the Veteran designation',
  },
] as const;

export function checkChip(result: string): { kind: StatusKind; text: string } {
  if (result === 'pass') return { kind: 'ok', text: 'Pass' };
  if (result === 'fail') return { kind: 'warn', text: 'Fail' };
  return { kind: 'off', text: 'Not run' };
}

/** §2.2.4: the reviewer sees the match result, never the values. */
export function identityMatchText(match: string | null): string {
  if (match === 'YES') return 'Matches the details given to VA: yes';
  if (match === 'NO') return 'Matches the details given to VA: no';
  return 'Matches the details given to VA: not read';
}

export function fingerprintText(inUse: boolean | null): string {
  if (inUse === null) return 'Licence number or state not read, so this cannot be checked.';
  return inUse
    ? 'This licence is already on an approved review in this tenant.'
    : 'This licence is not on any approved review.';
}

/** L5.3 by-eye checklist, sent as booleans on approve and confirm. */
export const CHECKLIST = [
  { key: 'selfie_matches', label: 'The selfie and the licence portrait show the same person.' },
  {
    key: 'security_features',
    label:
      "The card's visible security features look present, without signs of editing: a ghost portrait, a hologram or laminate pattern, microprint or a fine-line background, raised or tactile text, as the state uses them.",
  },
  {
    key: 'whole_card',
    label: 'The photo shows a whole physical card, not a screen or a printout.',
  },
] as const;

export type ChecklistKey = (typeof CHECKLIST)[number]['key'];

export const DECLINE_REASONS = [
  { value: 'NO_VETERAN_DESIGNATION', label: 'No Veteran designation' },
  { value: 'UNREADABLE', label: 'Photos cannot be read' },
  { value: 'EXPIRED', label: 'Licence expired' },
  { value: 'IDENTITY_MISMATCH', label: 'Does not match the details given to VA' },
  { value: 'SELFIE_MISMATCH', label: 'Selfie does not match the licence portrait' },
  { value: 'ALREADY_USED', label: 'Licence already used for another account' },
  { value: 'OTHER', label: 'Other' },
] as const;

export type DeclineReason = (typeof DECLINE_REASONS)[number]['value'];

export function declineReasonLabel(reason: string | null): string {
  return DECLINE_REASONS.find(({ value }) => value === reason)?.label ?? 'Other';
}

export const REVOKE_REASONS = [
  {
    value: 'FRAUD',
    label: 'Fraud',
    description:
      'Withdraws the confirmation. The person cannot ask for help or tell us they served.',
  },
  {
    value: 'REVIEW_ERROR',
    label: 'Review error',
    description:
      'The approval was a mistake. The person can send a licence again or tell us they served.',
  },
] as const;

export type RevokeReason = (typeof REVOKE_REASONS)[number]['value'];

export function revokeReasonLabel(reason: string | null): string {
  return REVOKE_REASONS.find(({ value }) => value === reason)?.label ?? 'Not stated';
}

/** "Sent 3 hours ago": the queue shows age, never names (L5.1). */
export function sentAgo(submittedAt: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(submittedAt)) / 60_000));
  if (minutes < 1) return 'Sent just now';
  if (minutes < 60) return `Sent ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Sent ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `Sent ${days} day${days === 1 ? '' : 's'} ago`;
}

const COMMAND_ERRORS: Readonly<Record<string, string>> = {
  SECOND_REVIEWER_REQUIRED:
    'You approved this review, so a different admin must confirm it. Nothing was changed.',
  SELF_REVIEW_FORBIDDEN: 'This review is about your own account, so you cannot decide it.',
  REVIEWER_RECUSED: 'You stepped back from this review, so you cannot decide it.',
  LICENCE_REVIEW_DECIDED: 'This review was already decided. The page now shows its current state.',
  LICENCE_REVIEW_NOT_READY:
    'This review is not in a state for that. The page now shows its current state.',
  LICENCE_FINGERPRINT_MISSING:
    "The licence number or state wasn't read, so this can't be approved. Decline it instead.",
  LICENCE_ALREADY_USED:
    'This licence is already approved for another account, so it cannot be approved. Nothing was changed. You can decline it with the reason "Licence already used for another account".',
  LICENCE_IDENTITY_MISMATCH:
    "The licence does not match the details given to VA, or they weren't read, so this can't be approved. You can decline it.",
  VALIDATION_FAILED: 'Answer the designation question and tick every check first.',
  IDEMPOTENCY_CONFLICT: 'That did not go through. Try again.',
};

/** Plain words for a failed review command. Never shows server text. */
export function licenceCommandError(error: unknown): string {
  if (isApiError(error)) {
    const known = COMMAND_ERRORS[error.code];
    if (known !== undefined) return known;
    if (error.status === 404) return 'We could not find this review.';
  }
  return 'That did not go through. Check your connection and try again.';
}

/** Plain words when the review itself cannot be opened (L5.1). */
export function licenceLoadError(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (error.code === 'SELF_REVIEW_FORBIDDEN' || error.code === 'REVIEWER_RECUSED') {
    return COMMAND_ERRORS[error.code] ?? null;
  }
  if (error.status === 404) return 'We could not find this review.';
  return null;
}
