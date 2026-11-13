/**
 * Deterministic licence reader fixture (LOCAL and TEST only): no network, synthetic data
 * (suas-specs R10.1, proposal). The outcome depends only on the front image's pixel width,
 * which the server's re-encode keeps, so tests and web e2e can pick one.
 */

import { readJpegFrame } from './licence-images.js';
import type {
  LicenceImages,
  LicenceReaderPort,
  LicenceReadResult,
  ReadField,
  YesNo,
} from './licence-reader.js';

/** Front-image widths that select a non-default outcome. Any other width reads normally. */
export const LICENCE_FIXTURE_WIDTHS = {
  NOT_A_LICENCE: 601,
  VETERAN_NO: 602,
  READER_UNAVAILABLE: 603,
  OTHER_IDENTITY: 604,
  NUMBER_NOT_READ: 605,
  NOT_SYNTHETIC: 607,
} as const;

/**
 * The default reading's identity. A VA attempt typed with these details gives identity
 * match YES; OTHER_IDENTITY reads a different first name and gives NO.
 */
export const LICENCE_FIXTURE_IDENTITY = {
  firstName: 'SYNTHETIC',
  lastName: 'VETERAN',
  birthDate: '1970-01-02',
} as const;
export const LICENCE_FIXTURE_NUMBER = 'F0000001';

const field = (value: string | null): ReadField => ({
  value,
  source: value === null ? null : 'barcode',
  agreed: value !== null,
});

function read(options: {
  veteran: Exclude<YesNo, null>;
  firstName: string;
  licenceNumber: string | null;
}): LicenceReadResult {
  return {
    status: 'READ',
    reading: {
      fields: {
        first_name: field(options.firstName),
        last_name: field(LICENCE_FIXTURE_IDENTITY.lastName),
        issue_date: field('2023-06-30'),
        expiry_date: field('2031-06-30'),
        issuing_state: field('CA'),
      },
      veteran: {
        value: options.veteran,
        source: 'barcode',
        agreed: true,
        barcode: options.veteran,
        front: options.veteran,
      },
      checks: {
        not_expired: 'pass',
        issued_before_expiry: 'pass',
        plausible_age: 'pass',
        veteran_designation_agrees: 'pass',
      },
    },
    secrets: {
      licenceNumber: options.licenceNumber,
      birthDate: LICENCE_FIXTURE_IDENTITY.birthDate,
    },
  };
}

export class FixtureLicenceReader implements LicenceReaderPort {
  readonly implementation = 'licence-reader-fixture';

  read(images: LicenceImages): Promise<LicenceReadResult> {
    const normal = {
      veteran: 'yes' as const,
      firstName: LICENCE_FIXTURE_IDENTITY.firstName,
      licenceNumber: LICENCE_FIXTURE_NUMBER,
    };
    switch (readJpegFrame(images.front)?.width) {
      case LICENCE_FIXTURE_WIDTHS.NOT_A_LICENCE:
        return Promise.resolve({ status: 'NOT_A_LICENCE' });
      case LICENCE_FIXTURE_WIDTHS.NOT_SYNTHETIC:
        return Promise.resolve({ status: 'NOT_SYNTHETIC' });
      case LICENCE_FIXTURE_WIDTHS.READER_UNAVAILABLE:
        return Promise.resolve({ status: 'UNAVAILABLE', failureClass: 'PROVIDER_UNAVAILABLE' });
      case LICENCE_FIXTURE_WIDTHS.VETERAN_NO:
        return Promise.resolve(read({ ...normal, veteran: 'no' }));
      case LICENCE_FIXTURE_WIDTHS.OTHER_IDENTITY:
        return Promise.resolve(read({ ...normal, firstName: 'OTHER' }));
      case LICENCE_FIXTURE_WIDTHS.NUMBER_NOT_READ:
        return Promise.resolve(read({ ...normal, licenceNumber: null }));
      default:
        return Promise.resolve(read(normal));
    }
  }
}
