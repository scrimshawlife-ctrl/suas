import { describe, expect, it } from 'vitest';
import {
  blobToBase64,
  encodeWithinLimit,
  fitWithin,
  LicenceImageError,
  MAX_BYTES,
  QUALITY_STEPS,
} from './licence-image';

const sized = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });

describe('fitWithin', () => {
  it('scales the long side down to 2000 px and keeps the ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2000, height: 1500 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1500, height: 2000 });
  });

  it('never scales a small photo up, so its width reaches the API unchanged', () => {
    expect(fitWithin(602, 380)).toEqual({ width: 602, height: 380 });
    expect(fitWithin(2000, 1200)).toEqual({ width: 2000, height: 1200 });
  });
});

describe('encodeWithinLimit', () => {
  it('keeps the first quality that fits', async () => {
    const tried: number[] = [];
    const blob = await encodeWithinLimit((quality) => {
      tried.push(quality);
      return Promise.resolve(sized(100));
    }, 1_000);
    expect(blob.size).toBe(100);
    expect(tried).toEqual([QUALITY_STEPS[0]]);
  });

  it('steps the quality down until the JPEG fits within 1 MB', async () => {
    const tried: number[] = [];
    const blob = await encodeWithinLimit((quality) =>
      Promise.resolve(sized(quality > 0.6 ? 1_400_000 : 900_000)).finally(() =>
        tried.push(quality),
      ),
    );
    expect(blob.size).toBe(900_000);
    expect(tried).toEqual([0.85, 0.75, 0.65, 0.55]);
  });

  it('gives up with too_large when even the lowest quality is over the limit', async () => {
    await expect(encodeWithinLimit(() => Promise.resolve(sized(2_000)), 1_000)).rejects.toEqual(
      new LicenceImageError('too_large'),
    );
  });
});

it('keeps three images as base64 under the 4,500,000-byte API body cap', () => {
  expect(MAX_BYTES).toBe(1_000_000);
  expect(Math.ceil((3 * MAX_BYTES) / 3) * 4).toBeLessThan(4_500_000 - 10_000);
});

describe('blobToBase64', () => {
  it('encodes the bytes with no data: prefix', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    expect(await blobToBase64(new Blob([bytes]))).toBe('/9j/4AAQ');
  });

  it('handles photos larger than one chunk', async () => {
    const bytes = new Uint8Array(70_000).map((_, index) => index % 251);
    const decoded = Uint8Array.from(atob(await blobToBase64(new Blob([bytes]))), (c) =>
      c.charCodeAt(0),
    );
    expect(decoded).toEqual(bytes);
  });
});
