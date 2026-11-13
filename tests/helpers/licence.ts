/**
 * Synthetic licence images for tests (suas-specs R10.1, proposal). Real JPEGs, so the
 * server's bounded decode and re-encode run on them; the width picks a fixture outcome.
 */

import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';

/** A plain grey JPEG of the given size. */
export function testJpeg(width = 640, height = 400, quality = 80): Uint8Array {
  const data = new Uint8Array(width * height * 4).fill(160);
  return new Uint8Array(jpeg.encode({ width, height, data }, quality).data);
}

/** Synthetic fixture files made by a PDF417 sample script; no real licence data. */
export function licenceFixture(
  name:
    | 'back-synthetic.jpg'
    | 'back-other-iin.jpg'
    | 'back-two-barcodes.jpg'
    | 'back-marker-in-body.jpg'
    | 'back-marker-only.jpg'
    | 'exif.jpg',
): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../fixtures/licence/${name}`, import.meta.url)));
}

/** The submit body the web sends: three base64 JPEGs and the notice version. */
export function licenceSubmission(
  options: { frontWidth?: number; noticeVersion?: string | undefined } = {},
) {
  const image = (bytes: Uint8Array) => ({
    content_type: 'image/jpeg',
    data_base64: Buffer.from(bytes).toString('base64'),
  });
  return {
    ...('noticeVersion' in options
      ? options.noticeVersion === undefined
        ? {}
        : { notice_version: options.noticeVersion }
      : { notice_version: 'licence-notice-v1' }),
    front: image(testJpeg(options.frontWidth ?? 640)),
    back: image(licenceFixture('back-synthetic.jpg')),
    selfie: image(testJpeg(480, 640)),
  };
}
