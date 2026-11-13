/**
 * What the Veteran's licence page shows, from the licence review (suas-specs #73 R10.1 proposal,
 * SCRY_LICENCE_FALLBACK.md L2 to L8). Raw states, failure classes and reason codes never reach
 * the page; each maps to a view with its own heading.
 */
export type LicenceReviewStatus =
  | 'READING'
  | 'UNREADABLE'
  | 'AWAITING_REVIEW'
  | 'AWAITING_CONFIRMATION'
  | 'APPROVED'
  | 'DECLINED'
  | 'REVOKED';

/** The part of the API's licence review the page branches on. */
export interface LicenceReviewState {
  review_id: string;
  status: LicenceReviewStatus;
  decline_reason: string | null;
  failure_class: string | null;
}

export type LicenceView =
  | 'not_offered'
  | 'form'
  | 'reading'
  | 'reader_down'
  | 'unreadable'
  | 'photos_lost'
  | 'not_synthetic'
  | 'awaiting'
  | 'approved'
  | 'declined'
  | 'withdrawn'
  | 'limit'
  | 'closed'
  | 'revoked';

/** A submit this visit that the server refused with its own view (429, 503 or 403 revoked). */
export type LicenceRefusal = 'limit' | 'closed' | 'revoked';

export interface LicenceViewInput {
  /** `id_verification` from GET /veterans/me. */
  standing: { status: string; method?: string } | undefined;
  offered: boolean;
  review: LicenceReviewState | null;
  refused: LicenceRefusal | null;
  /** The settled review the person chose to replace with new photos (or to dispute). */
  replacing: string | null;
}

/** UNREADABLE classes that are not the reader's fault or answer (L4, L8.2). */
function unreadableView(failureClass: string | null): LicenceView {
  switch (failureClass) {
    case 'NOT_A_LICENCE':
      return 'unreadable';
    case 'PHOTOS_EXPIRED':
    case 'PHOTOS_GONE':
      return 'photos_lost';
    case 'NOT_SYNTHETIC':
      return 'not_synthetic';
    default:
      // Every other class is a reader or transport failure (L4.5): "the reader is down".
      return 'reader_down';
  }
}

/**
 * Picks the view. A revoked standing and an approval win; then a refused submit; then an open
 * review; then a settled one, unless the person chose to replace it. A person who is not offered
 * the path, with nothing to show, goes back to Verify.
 */
export function licenceView({
  standing,
  offered,
  review,
  refused,
  replacing,
}: LicenceViewInput): LicenceView {
  if (standing?.status === 'REVOKED' || refused === 'revoked') return 'revoked';
  if (review?.status === 'APPROVED') return 'approved';
  // Confirmed some other way (VA or self-attestation): Verify says so.
  if (standing?.status === 'VERIFIED') return 'not_offered';
  if (refused !== null) return refused;
  switch (review?.status) {
    case 'READING':
      return 'reading';
    case 'AWAITING_REVIEW':
    case 'AWAITING_CONFIRMATION':
      return 'awaiting';
  }
  if (review !== null && replacing !== review.review_id) {
    if (review.status === 'UNREADABLE') return unreadableView(review.failure_class);
    if (review.status === 'DECLINED') return 'declined';
    if (review.status === 'REVOKED') return 'withdrawn';
  }
  return offered ? 'form' : 'not_offered';
}

/** True while a review waits on the reader or an admin (one open review per person, L1). */
export function isOpenReview(status: LicenceReviewStatus | undefined): boolean {
  return status === 'READING' || status === 'AWAITING_REVIEW' || status === 'AWAITING_CONFIRMATION';
}

/** Polling: every few seconds while the reader reads (L2.4), slower while admins have it. */
export function licencePollInterval(status: LicenceReviewStatus | undefined): number | false {
  if (status === 'READING') return 3_500;
  if (status === 'AWAITING_REVIEW' || status === 'AWAITING_CONFIRMATION') return 30_000;
  return false;
}

export const LICENCE_HEADINGS: Readonly<Record<Exclude<LicenceView, 'not_offered'>, string>> = {
  form: 'Confirm with your Veteran licence',
  reading: "We're reading your licence",
  reader_down: 'Our licence reader is down',
  unreadable: "We couldn't read those photos",
  photos_lost: 'Please send your photos again',
  not_synthetic: 'This version only reads sample licences',
  awaiting: 'A SUAS admin will check your licence',
  approved: "You're confirmed",
  declined: "We couldn't confirm your Veteran status from your licence",
  withdrawn: 'Your licence approval was withdrawn',
  limit: "You've reached the limit for licence reviews",
  closed: 'Licence review is off right now',
  revoked: 'Your confirmation was withdrawn',
};

/** Views whose outcome did not use one of the person's tries (L8.2). */
export const NOT_COUNTED_VIEWS: ReadonlySet<LicenceView> = new Set([
  'reader_down',
  'photos_lost',
  'not_synthetic',
]);

/** L6.1: the approval line, on the licence page and on Verify for a MANUAL_REVIEW standing. */
export const LICENCE_APPROVED_TEXT =
  'A SUAS admin confirmed your Veteran status from your licence. You can ask for help now.';

/** What helps the reader with a card it could not read. */
export const UNREADABLE_TIPS: readonly string[] = [
  'Lay the card on a flat surface.',
  'Use good light.',
  'Get the whole card in view.',
  'Keep glare off the barcode on the back.',
];

const DECLINE_REASON_TEXT: Readonly<Record<string, string>> = {
  NO_VETERAN_DESIGNATION: 'The admin could not see a Veteran designation on the licence.',
  UNREADABLE: 'The admin could not read the photos clearly enough.',
  EXPIRED: 'The licence has expired.',
  IDENTITY_MISMATCH:
    'The name or date of birth on the licence did not match the details you gave VA. If your licence spells your name differently, you can try VA with that spelling, then send your licence again.',
  SELFIE_MISMATCH: 'The admin could not match your selfie to the photo on the licence.',
  ALREADY_USED: 'This licence has already been used to confirm Veteran status on SUAS.',
  OTHER: 'The admin could not confirm your Veteran status from these photos.',
};

/** The decline reason in plain words (L6.2). An unknown or missing reason reads as OTHER. */
export function declineReasonText(reason: string | null | undefined): string {
  return DECLINE_REASON_TEXT[reason ?? 'OTHER'] ?? (DECLINE_REASON_TEXT.OTHER as string);
}
