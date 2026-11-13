/**
 * Scry adapter for the licence reader port: `POST {base}/api/v1/id-read`, multipart front
 * and back, bearer token (suas-specs R10.1, proposal; §2.1, L4). The response is parsed
 * strictly: any key outside the minimized schema is PROVIDER_RESPONSE_INVALID, so a reader
 * that starts returning more than §2.1 allows is treated as unavailable, not trusted.
 */

import { z } from 'zod';
import { hasSyntheticMarker } from './licence-barcode.js';
import type {
  LicenceImages,
  LicenceReaderPort,
  LicenceReaderUnavailableClass,
  LicenceReadResult,
} from './licence-reader.js';
import type { FetchTransport } from './va-confirmation-http.js';

export const SCRY_READER_IMPLEMENTATION = 'licence-reader-scry' as const;

/**
 * One call per worker pass: 75 s leaves about 45 s of the 2-minute worker for the sweeps,
 * the S3 reads, the barcode decode, the settle transaction and a cold start.
 */
export const SCRY_READ_TIMEOUT_MS = 75_000;
/** A reading is well under a kilobyte; anything past this is refused unread. */
export const MAX_RESPONSE_BYTES = 64 * 1024;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();
const yesNo = z.enum(['yes', 'no']).nullable();
const source = z.enum(['barcode', 'front']).nullable();
const text = z.string().min(1).max(64).nullable();
const textField = z.object({ value: text, source, agreed: z.boolean() }).strict();
const dateField = z.object({ value: isoDate, source, agreed: z.boolean() }).strict();
const check = z.enum(['pass', 'fail', 'not_run']);

const fieldsSchema = z
  .object({
    veteran: z
      .object({ value: yesNo, source, agreed: z.boolean(), barcode: yesNo, front: yesNo })
      .strict(),
    first_name: textField,
    last_name: textField,
    birth_date: dateField,
    issue_date: dateField,
    expiry_date: dateField,
    issuing_state: textField,
    licence_number: textField,
  })
  .strict();
const checksSchema = z
  .object({
    not_expired: check,
    issued_before_expiry: check,
    plausible_age: check,
    veteran_designation_agrees: check,
  })
  .strict();
const markerSchema = z
  .object({
    required: z.boolean(),
    present: z.boolean(),
    iin: z
      .string()
      .regex(/^\d{6}$/)
      .nullable(),
  })
  .strict();
const seconds = z.number().nonnegative();

const answerSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('read'),
      seconds,
      synthetic_marker: markerSchema,
      licence: z.object({ fields: fieldsSchema, checks: checksSchema }).strict(),
    })
    .strict(),
  z
    .object({ status: z.literal('not_a_licence'), seconds, synthetic_marker: markerSchema })
    .strict(),
  z.object({ status: z.literal('failed'), seconds, message: z.string().max(512) }).strict(),
]);

export interface ScryReaderOptions {
  readonly baseUrl: string | undefined;
  readonly apiToken: string | undefined;
  /**
   * Outside LOCAL and TEST, as defence in depth beside the worker's own check: the back
   * must carry `syntheticIin` before any call; an answer whose marker IIN is not
   * `syntheticIin` is PROVIDER_RESPONSE_INVALID; and every value read must come from the
   * barcode with the front agreeing, or the result is NOT_SYNTHETIC, since a real front
   * beside a synthetic back shows as a mismatch.
   */
  readonly requireMarker: boolean;
  readonly syntheticIin?: string | undefined;
  readonly transport?: FetchTransport;
  readonly timeoutMs?: number;
}

/**
 * `failed` messages that are Scry's deterministic synthetic refusals, not outages: the
 * barcode lacks the marker, or the printed front contradicts it. Matched on Scry's fixed
 * strings, since `failed` carries no code; any other message is an outage.
 */
const SCRY_SYNTHETIC_REFUSALS: ReadonlySet<string> = new Set([
  'NOT_SYNTHETIC',
  'FRONT_MISMATCH',
  "Scry's reader found a licence barcode without the synthetic marker; nothing was read.",
  'The printed front does not match the synthetic barcode, so the card is not shown to be synthetic; nothing was read.',
]);

const unavailable = (failureClass: LicenceReaderUnavailableClass): LicenceReadResult => ({
  status: 'UNAVAILABLE',
  failureClass,
});

export class ScryLicenceReader implements LicenceReaderPort {
  readonly implementation = SCRY_READER_IMPLEMENTATION;

  private readonly transport: FetchTransport;

  constructor(private readonly options: ScryReaderOptions) {
    this.transport = options.transport ?? { fetch: (url, init) => fetch(url, init) };
  }

  async read(images: LicenceImages): Promise<LicenceReadResult> {
    const { baseUrl, apiToken } = this.options;
    // Fails closed without a call: the token lives only where the read runs.
    if (baseUrl === undefined || apiToken === undefined || apiToken === '') {
      return unavailable('CONFIGURATION_INVALID');
    }
    if (this.options.requireMarker && !hasSyntheticMarker(images.back, this.options.syntheticIin)) {
      return { status: 'NOT_SYNTHETIC' };
    }
    const form = new FormData();
    form.append('front', new Blob([images.front], { type: 'image/jpeg' }), 'front.jpg');
    form.append('back', new Blob([images.back], { type: 'image/jpeg' }), 'back.jpg');

    let response: Response;
    let body: string | undefined;
    try {
      response = await this.transport.fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/id-read`, {
        method: 'POST',
        redirect: 'error',
        headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? SCRY_READ_TIMEOUT_MS),
      });
      const declared = Number(response.headers.get('content-length') ?? '0');
      body = declared > MAX_RESPONSE_BYTES ? undefined : await readBounded(response);
    } catch (error: unknown) {
      return unavailable(isTimeoutError(error) ? 'TIMEOUT' : 'NETWORK_ERROR');
    }
    if (response.status !== 200) return fromErrorStatus(response.status, body);
    const contentType = response.headers.get('content-type') ?? '';
    if (body === undefined || !/^application\/json\b/i.test(contentType)) {
      return unavailable('PROVIDER_RESPONSE_INVALID');
    }
    return fromBody(body, this.options.requireMarker ? this.options.syntheticIin : undefined);
  }
}

/**
 * The body as text, or undefined once it passes the cap; the stream is then cancelled.
 * Scry streams keep-alive spaces with no Content-Length, so the count is the real guard.
 */
async function readBounded(response: Response): Promise<string | undefined> {
  if (response.body === null) return '';
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 422 NOT_SYNTHETIC is Scry's own synthetic check (L4.3). 404 means Scry has no token set,
 * so its read route is off. 413 and 503 are edge or busy refusals: unavailable, retried.
 */
function fromErrorStatus(status: number, body: string | undefined): LicenceReadResult {
  if (status === 422 && readCode(body) === 'NOT_SYNTHETIC') return { status: 'NOT_SYNTHETIC' };
  if (status === 401 || status === 403) return unavailable('AUTHENTICATION_REJECTED');
  if (status === 404) return unavailable('CONFIGURATION_INVALID');
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return unavailable('REQUEST_INVALID');
  }
  if (status === 429 || (status >= 500 && status <= 599)) {
    return unavailable('PROVIDER_UNAVAILABLE');
  }
  return unavailable('PROVIDER_RESPONSE_INVALID');
}

function readCode(body: string | undefined): unknown {
  try {
    return (JSON.parse(body ?? '') as { code?: unknown } | null)?.code;
  } catch {
    return undefined;
  }
}

/** Only the parsed answer leaves here; the raw body is never logged or returned. */
/** `markerIin` is set only where the marker rules apply (outside LOCAL and TEST). */
function fromBody(body: string, markerIin: string | undefined): LicenceReadResult {
  const requireMarker = markerIin !== undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(body.trim());
  } catch {
    return unavailable('PROVIDER_RESPONSE_INVALID');
  }
  const parsed = answerSchema.safeParse(payload);
  if (!parsed.success) return unavailable('PROVIDER_RESPONSE_INVALID');
  const answer = parsed.data;
  if (answer.status === 'failed') {
    return SCRY_SYNTHETIC_REFUSALS.has(answer.message)
      ? { status: 'NOT_SYNTHETIC' }
      : unavailable('PROVIDER_UNAVAILABLE');
  }
  // On not_a_licence too: the IIN is that of the one barcode Scry's gate accepted.
  const marker = answer.synthetic_marker;
  if (requireMarker && (marker.present !== true || marker.iin !== markerIin)) {
    return unavailable('PROVIDER_RESPONSE_INVALID');
  }
  if (answer.status === 'not_a_licence') return { status: 'NOT_A_LICENCE' };
  const { fields, checks } = answer.licence;
  const notFromAgreeingBarcode = Object.values(fields).some(
    (field) => field.value !== null && (field.source !== 'barcode' || !field.agreed),
  );
  if (requireMarker && notFromAgreeingBarcode) return { status: 'NOT_SYNTHETIC' };
  return {
    status: 'READ',
    reading: {
      fields: {
        first_name: fields.first_name,
        last_name: fields.last_name,
        issue_date: fields.issue_date,
        expiry_date: fields.expiry_date,
        issuing_state: fields.issuing_state,
      },
      veteran: fields.veteran,
      checks,
    },
    secrets: {
      licenceNumber: fields.licence_number.value,
      birthDate: fields.birth_date.value,
    },
  };
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}
