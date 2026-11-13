/**
 * Licence images: upload hardening and object storage (suas-specs R10.1, proposal; L3, §2.3).
 *
 * Every image is checked from its JPEG header before any decode, decoded with pixel and
 * memory limits, and re-encoded to a fresh baseline JPEG. Only that copy is kept, so EXIF
 * (with any GPS position), XMP, ICC, comments and thumbnails never reach storage or the
 * reader. Keys hold the review id and side only, never personal data.
 */

import jpeg from 'jpeg-js';
import type { ObjectStoragePort } from '../storage/object-storage.js';

export const LICENCE_IMAGE_PREFIX = 'licence-reviews/';
export const LICENCE_IMAGE_SIDES = ['front', 'back', 'selfie'] as const;
export type LicenceImageSide = (typeof LICENCE_IMAGE_SIDES)[number];
export type LicenceImageSet = Readonly<Record<LicenceImageSide, Uint8Array>>;

/** L3.1 as amended for the 6 MB Lambda request limit: 2000 px long side, 1 MB per image. */
export const LICENCE_MAX_EDGE_PX = 2000;
export const LICENCE_MAX_IMAGE_BYTES = 1_000_000;
/** Bounded decode: a 2000 x 2000 image is 4 MP, and jpeg-js counts about 73 MB to decode it. */
const MAX_DECODE_MP = 4;
const MAX_DECODE_MEMORY_MB = 96;
const REENCODE_QUALITY = 90;
const JPEG = 'image/jpeg';

/** Baseline, extended and progressive Huffman frames; jpeg-js decodes no other kind. */
const DECODABLE_FRAMES = new Set([0xc0, 0xc1, 0xc2]);

export interface JpegFrame {
  readonly marker: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The start-of-frame before the first scan, or undefined when the bytes are not a JPEG,
 * have no frame, or have more than one before the scan (a second frame could make the
 * decoder see a different size than this header check).
 */
export function readJpegFrame(bytes: Uint8Array): JpegFrame | undefined {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const at = (index: number) => bytes[index] ?? 0;
  let frame: JpegFrame | undefined;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (at(offset) !== 0xff) return undefined;
    const marker = at(offset + 1);
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xda) return frame;
    if (marker === 0xd9) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2; // markers with no length
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isFrame) {
      if (frame !== undefined || offset + 8 >= bytes.length) return undefined;
      frame = {
        marker,
        height: (at(offset + 5) << 8) | at(offset + 6),
        width: (at(offset + 7) << 8) | at(offset + 8),
      };
    }
    offset += 2 + ((at(offset + 2) << 8) | at(offset + 3));
  }
  return undefined;
}

/** The image broke an L3 rule. The caller names the field only, never the content. */
export class LicenceImageRejectedError extends Error {
  constructor(readonly reason: 'too_large' | 'not_jpeg' | 'too_many_pixels' | 'undecodable') {
    super(`Licence image rejected: ${reason}`);
    this.name = 'LicenceImageRejectedError';
  }
}

/** Decoded RGBA pixels under the decode limits; throws when the image breaks a rule. */
export function decodeLicenceImage(bytes: Uint8Array): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  if (bytes.length > LICENCE_MAX_IMAGE_BYTES) throw new LicenceImageRejectedError('too_large');
  const frame = readJpegFrame(bytes);
  if (frame === undefined || !DECODABLE_FRAMES.has(frame.marker)) {
    throw new LicenceImageRejectedError('not_jpeg');
  }
  const inRange = (side: number) => side >= 1 && side <= LICENCE_MAX_EDGE_PX;
  if (!inRange(frame.width) || !inRange(frame.height)) {
    throw new LicenceImageRejectedError('too_many_pixels');
  }
  try {
    const decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_DECODE_MP,
      maxMemoryUsageInMB: MAX_DECODE_MEMORY_MB,
    });
    if (!decodedMatchesFrame(frame, decoded)) throw new LicenceImageRejectedError('undecodable');
    return { width: decoded.width, height: decoded.height, data: decoded.data };
  } catch {
    throw new LicenceImageRejectedError('undecodable');
  }
}

/** The decoder saw the size the header check passed, within the cap (no parser differential). */
export function decodedMatchesFrame(
  frame: JpegFrame,
  decoded: { readonly width: number; readonly height: number },
): boolean {
  return (
    decoded.width === frame.width &&
    decoded.height === frame.height &&
    decoded.width <= LICENCE_MAX_EDGE_PX &&
    decoded.height <= LICENCE_MAX_EDGE_PX
  );
}

/**
 * L3.2–L3.3: a fresh baseline JPEG of the decoded pixels. Only width, height and pixels are
 * passed to the encoder, so no EXIF or comment from the upload can be carried across.
 */
export function hardenLicenceImage(bytes: Uint8Array): Uint8Array {
  const { width, height, data } = decodeLicenceImage(bytes);
  return new Uint8Array(jpeg.encode({ width, height, data }, REENCODE_QUALITY).data);
}

export function licenceImageKey(reviewId: string, side: LicenceImageSide): string {
  return `${LICENCE_IMAGE_PREFIX}${reviewId}/${side}.jpg`;
}

/** Stores the three re-encoded images. */
export async function putLicenceImages(
  storage: ObjectStoragePort,
  reviewId: string,
  images: LicenceImageSet,
): Promise<void> {
  for (const side of LICENCE_IMAGE_SIDES) {
    await storage.put({
      key: licenceImageKey(reviewId, side),
      body: images[side],
      contentType: JPEG,
    });
  }
}

/** One stored image, or undefined when storage says it is gone (404 is PHOTOS_GONE, L4.7). */
export async function getLicenceImage(
  storage: ObjectStoragePort,
  reviewId: string,
  side: LicenceImageSide,
): Promise<Uint8Array | undefined> {
  return (await storage.get(licenceImageKey(reviewId, side)))?.body;
}

/** Deletes all three; an absent key succeeds, so a retried delete is safe. */
export async function deleteLicenceImages(
  storage: ObjectStoragePort,
  reviewId: string,
): Promise<void> {
  for (const side of LICENCE_IMAGE_SIDES) {
    await storage.delete(licenceImageKey(reviewId, side));
  }
}
