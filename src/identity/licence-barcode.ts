/**
 * The SUAS-side synthetic check (suas-specs R10.1, proposal; L4.2). Outside LOCAL and TEST
 * the job worker decodes the PDF417 on the back itself, before anything leaves for the
 * reader. It fails closed: across the 0°, 90° and 270° scans (the decoder adds 180°) the
 * back must show exactly one PDF417 region, the same payload in every scan that finds it,
 * with an AAMVA header at its start carrying the configured IIN and the mandatory DAQ, DCS,
 * DAC and DBB elements. No code, two regions, a non-AAMVA code, another IIN, a marker-only
 * code, or a region found but not decodable all fail. A code too damaged for the detector
 * to find at all is not seen: that is a known limit.
 *
 * This gate is not the only control keeping a real licence from the reader: the reader
 * checks the marker again, a front that disagrees with the barcode is refused, and STAGING
 * runs on synthetic documents only by process.
 */

import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HybridBinarizer,
  NotFoundException,
  PDF417Reader,
  RGBLuminanceSource,
  type Result,
} from '@zxing/library';
import { decodeLicenceImage } from './licence-images.js';

/**
 * The AAMVA header at the very start of the payload: "@", the separators, "ANSI" (or
 * "AAMVA" before 2000), the 6-digit IIN, the version digits, then the first subfile type.
 * The same rule as the reader's own gate, so the two checks agree.
 */
// eslint-disable-next-line no-control-regex -- AAMVA separators are control characters.
const AAMVA_HEADER = /^@[\n\r\x1c-\x1f ]*(?:ANSI ?|AAMVA)(\d{6})\d{4,6}(?:DL|ID)/;

/** The IIN of an AAMVA payload, or undefined when the header is not at its start. */
export function aamvaIin(payload: string): string | undefined {
  return AAMVA_HEADER.exec(payload)?.[1];
}

/** Licence number, last name, first name, birth date: a marker-only barcode lacks them. */
const MANDATORY_ELEMENTS = ['DAQ', 'DCS', 'DAC', 'DBB'] as const;
const hasElement = (payload: string, element: string) =>
  new RegExp(`(?:DL|ID|[\\n\\r])${element}[^\\n\\r]`).test(payload);

/**
 * `decodeMultiple` turns a found-but-undecodable code into "not found". The static decoder
 * it wraps (private in the 0.23 typings, public at run time) detects every region first and
 * then decodes each, letting a decode error through, so one result per detected region
 * comes back or the scan fails. Missing, the check fails closed.
 */
type MultiDecode = (
  image: BinaryBitmap,
  hints: Map<DecodeHintType, unknown>,
  multiple: true,
) => Result[];
const multiDecode = (PDF417Reader as unknown as { decode?: MultiDecode }).decode;

const HINTS = new Map<DecodeHintType, unknown>([
  [DecodeHintType.TRY_HARDER, true],
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.PDF_417]],
]);

/** Quarter turn clockwise (`clockwise`) or anticlockwise of a luminance plane. */
function rotate(plane: Uint8ClampedArray, width: number, height: number, clockwise: boolean) {
  const out = new Uint8ClampedArray(plane.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const target = clockwise ? x * height + (height - 1 - y) : (width - 1 - x) * height + y;
      out[target] = plane[y * width + x] ?? 0;
    }
  }
  return out;
}

/** One payload per region in one orientation; undefined when a region did not decode. */
function scan(plane: Uint8ClampedArray, width: number, height: number): string[] | undefined {
  if (multiDecode === undefined) return undefined;
  const bitmap = new BinaryBitmap(
    new HybridBinarizer(new RGBLuminanceSource(plane, width, height)),
  );
  try {
    return multiDecode
      .call(PDF417Reader, bitmap, HINTS, true)
      .filter((result) => result.getBarcodeFormat() === BarcodeFormat.PDF_417)
      .map((result) => result.getText());
  } catch (error: unknown) {
    return error instanceof NotFoundException ? [] : undefined;
  }
}

/**
 * The distinct PDF417 payloads across the 0°, 90° and 270° scans, or undefined when the
 * image does not decode, a scan found a region it could not read, or a scan found more
 * than one region.
 */
export function readPdf417Payloads(back: Uint8Array): string[] | undefined {
  let image: { width: number; height: number; data: Uint8Array };
  try {
    image = decodeLicenceImage(back);
  } catch {
    return undefined;
  }
  const { width, height, data } = image;
  const plane = new Uint8ClampedArray(width * height);
  for (let pixel = 0, offset = 0; pixel < plane.length; pixel += 1, offset += 4) {
    plane[pixel] =
      ((data[offset] ?? 0) * 299 + (data[offset + 1] ?? 0) * 587 + (data[offset + 2] ?? 0) * 114) /
      1000;
  }
  const scans = [
    scan(plane, width, height),
    scan(rotate(plane, width, height, true), height, width),
    scan(rotate(plane, width, height, false), height, width),
  ];
  if (scans.some((found) => found === undefined || found.length > 1)) return undefined;
  return [...new Set(scans.flatMap((found) => found ?? []))];
}

/** True only for one PDF417 with the anchored header, `syntheticIin` and every element. */
export function hasSyntheticMarker(back: Uint8Array, syntheticIin: string | undefined): boolean {
  if (syntheticIin === undefined) return false;
  const payloads = readPdf417Payloads(back);
  const payload = payloads?.length === 1 ? (payloads[0] ?? '') : undefined;
  return (
    payload !== undefined &&
    aamvaIin(payload) === syntheticIin &&
    MANDATORY_ELEMENTS.every((element) => hasElement(payload, element))
  );
}
