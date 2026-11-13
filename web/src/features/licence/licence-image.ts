/**
 * Licence photos and the selfie as the API takes them: a JPEG at most 2000 px on the long side
 * (suas-specs #73 R10.1 proposal, SCRY_LICENCE_FALLBACK.md L2.2, L3.1). All three go in one
 * request, as base64 (about 1.33 times the bytes), under the API's 4,500,000-byte body cap, so each
 * is kept at most 1,000,000 bytes (coordinator decision, 2026-11-11). The server re-encodes each
 * image and strips its metadata.
 */
export const MAX_EDGE = 2000;
export const MAX_BYTES = 1_000_000;
/** Tried in order until the JPEG fits within MAX_BYTES. */
export const QUALITY_STEPS = [0.85, 0.75, 0.65, 0.55, 0.45] as const;

/** Why a photo could not be prepared: the browser could not decode it, or it never fit. */
export class LicenceImageError extends Error {
  constructor(readonly reason: 'unreadable' | 'too_large') {
    super(reason === 'unreadable' ? 'The photo could not be opened.' : 'The photo is too large.');
    this.name = 'LicenceImageError';
  }
}

/** Scales a size down (never up) so its long side is at most `maxEdge`, keeping the ratio. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = MAX_EDGE,
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Encodes at each quality step and returns the first result within `maxBytes`. */
export async function encodeWithinLimit(
  encode: (quality: number) => Promise<Blob>,
  maxBytes: number = MAX_BYTES,
): Promise<Blob> {
  for (const quality of QUALITY_STEPS) {
    const blob = await encode(quality);
    if (blob.size <= maxBytes) return blob;
  }
  throw new LicenceImageError('too_large');
}

/** The bytes as plain base64 (no `data:` prefix), in chunks so large photos do not overflow. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    // Applies the camera's EXIF rotation, so the card is the right way up.
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new LicenceImageError('unreadable');
  }
}

/** Draws a decoded image or a camera frame scaled to fit MAX_EDGE, as a JPEG within MAX_BYTES. */
export async function drawToJpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<Blob> {
  const size = fitWithin(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) throw new LicenceImageError('unreadable');
  // A transparent PNG would turn black in a JPEG.
  context.fillStyle = '#fff';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);
  return encodeWithinLimit(
    (quality) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new LicenceImageError('unreadable'))),
          'image/jpeg',
          quality,
        ),
      ),
  );
}

/** Decodes a picked licence photo and re-encodes it with drawToJpeg. */
export async function toLicenceJpeg(file: File): Promise<Blob> {
  const bitmap = await decode(file);
  try {
    return await drawToJpeg(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
