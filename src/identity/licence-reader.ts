/**
 * Licence reader port (suas-specs R10.1, proposal; §2.1, L4). It reads the front and back
 * photos of a state licence for a SUAS Admin; the reading never decides a standing. It
 * never receives the selfie, and it never throws for a provider outcome.
 */

/** The two sides the reader may see. The selfie is not part of this type on purpose. */
export interface LicenceImages {
  readonly front: Uint8Array;
  readonly back: Uint8Array;
}

/** The reader could not answer (L4.5). These never count toward the limits (L8.2). */
export const LICENCE_READER_UNAVAILABLE_CLASSES = [
  'CONFIGURATION_INVALID',
  'AUTHENTICATION_REJECTED',
  'REQUEST_INVALID',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RESPONSE_INVALID',
  'TIMEOUT',
  'NETWORK_ERROR',
] as const;
export type LicenceReaderUnavailableClass = (typeof LICENCE_READER_UNAVAILABLE_CLASSES)[number];

/** Every reason a review can settle UNREADABLE; migration 0024 bounds the column to it. */
export const LICENCE_FAILURE_CLASSES = [
  ...LICENCE_READER_UNAVAILABLE_CLASSES,
  'NOT_A_LICENCE',
  'NOT_SYNTHETIC',
  'PHOTOS_GONE',
  'PHOTOS_EXPIRED',
] as const;
export type LicenceFailureClass = (typeof LICENCE_FAILURE_CLASSES)[number];

/** L8.1: only an answer from the reader counts, and NOT_A_LICENCE is the one failure that does. */
export const COUNTED_FAILURE_CLASSES: readonly LicenceFailureClass[] = ['NOT_A_LICENCE'];

export const isReaderUnavailable = (value: string): value is LicenceReaderUnavailableClass =>
  (LICENCE_READER_UNAVAILABLE_CLASSES as readonly string[]).includes(value);

export type YesNo = 'yes' | 'no' | null;
export type FieldSource = 'barcode' | 'front' | null;
export type CheckResult = 'pass' | 'fail' | 'not_run';

export interface ReadField {
  readonly value: string | null;
  readonly source: FieldSource;
  /** The barcode and the front, or the two model reads, agreed. */
  readonly agreed: boolean;
}

export interface VeteranField {
  readonly value: YesNo;
  readonly source: FieldSource;
  readonly agreed: boolean;
  readonly barcode: YesNo;
  readonly front: YesNo;
}

/** The fields a reviewer may see (§2.1, without licence number or birth date). */
export const SHOWN_FIELD_KEYS = [
  'first_name',
  'last_name',
  'issue_date',
  'expiry_date',
  'issuing_state',
] as const;
export type ShownFieldKey = (typeof SHOWN_FIELD_KEYS)[number];

export const CONSISTENCY_CHECK_KEYS = [
  'not_expired',
  'issued_before_expiry',
  'plausible_age',
  'veteran_designation_agrees',
] as const;
export type ConsistencyCheckKey = (typeof CONSISTENCY_CHECK_KEYS)[number];

/** What may be stored in `read_result` until the decision. Holds no hashed-only value. */
export interface LicenceReading {
  readonly fields: Readonly<Record<ShownFieldKey, ReadField>>;
  readonly veteran: VeteranField;
  /** Consistency checks only; they do not show the card is genuine (§3). */
  readonly checks: Readonly<Record<ConsistencyCheckKey, CheckResult>>;
}

/**
 * Values used only to compute the fingerprint and the identity match, then dropped (§2.2).
 * Kept apart from `LicenceReading` so they cannot be stored with it by accident.
 */
export interface LicenceSecrets {
  readonly licenceNumber: string | null;
  readonly birthDate: string | null;
}

export type LicenceReadResult =
  | { readonly status: 'READ'; readonly reading: LicenceReading; readonly secrets: LicenceSecrets }
  | { readonly status: 'NOT_A_LICENCE' }
  | { readonly status: 'NOT_SYNTHETIC' }
  | { readonly status: 'UNAVAILABLE'; readonly failureClass: LicenceReaderUnavailableClass };

export interface LicenceReaderPort {
  readonly implementation: string;
  /** One read per call; resolves for every provider outcome. */
  read(images: LicenceImages): Promise<LicenceReadResult>;
}
