/**
 * The Scry adapter's minimized schema and failure mapping, the L3 upload hardening and the
 * L4.2 synthetic barcode check (suas-specs R10.1, proposal). All data is synthetic.
 */

import jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { hasSyntheticMarker, readPdf417Payloads } from '../../src/identity/licence-barcode.js';
import {
  decodedMatchesFrame,
  hardenLicenceImage,
  LicenceImageRejectedError,
  readJpegFrame,
} from '../../src/identity/licence-images.js';
import { ScryLicenceReader } from '../../src/identity/licence-reader-scry.js';
import type { FetchTransport } from '../../src/identity/va-confirmation-http.js';
import { licenceFixture, testJpeg } from '../helpers/licence.js';

const BASE = 'https://reader.example.test';
const images = { front: testJpeg(), back: licenceFixture('back-synthetic.jpg') };

function readAnswer() {
  const field = (value: string | null) => ({ value, source: 'barcode', agreed: true });
  return {
    status: 'read',
    seconds: 41.3,
    synthetic_marker: { required: true, present: true, iin: '999999' },
    licence: {
      fields: {
        veteran: { value: 'yes', source: 'barcode', agreed: false, barcode: 'yes', front: 'no' },
        first_name: field('JANE'),
        last_name: field('RIVERA'),
        birth_date: field('1989-07-22'),
        issue_date: field('2023-07-22'),
        expiry_date: field('2031-07-22'),
        issuing_state: { value: 'CA', source: 'front', agreed: true },
        licence_number: field('R7392041'),
      },
      checks: {
        not_expired: 'pass',
        issued_before_expiry: 'pass',
        plausible_age: 'pass',
        veteran_designation_agrees: 'fail',
      },
    },
  };
}

/** A transport answering once, recording what was sent. */
function answering(status: number, body: string, options: { requireMarker?: boolean } = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const transport: FetchTransport = {
    fetch: (url, init) => {
      sent.push({ url, init });
      return Promise.resolve(
        new Response(body, { status, headers: { 'content-type': 'application/json' } }),
      );
    },
  };
  return {
    sent,
    reader: new ScryLicenceReader({
      baseUrl: BASE,
      apiToken: 'tok',
      requireMarker: options.requireMarker ?? true,
      syntheticIin: '999999',
      transport,
    }),
  };
}

describe('Scry licence reader', () => {
  it('parses a read, keeps the number and birth date apart, and sends front and back only', async () => {
    // As in LOCAL: no marker rules, so Scry's sample answer with a disagreeing front reads.
    const { sent, reader } = answering(200, `   \n  ${JSON.stringify(readAnswer())}`, {
      requireMarker: false,
    });
    const result = await reader.read(images);
    expect(result.status).toBe('READ');
    if (result.status !== 'READ') return;
    expect(result.secrets).toEqual({ licenceNumber: 'R7392041', birthDate: '1989-07-22' });
    expect(Object.keys(result.reading.fields).sort()).toEqual([
      'expiry_date',
      'first_name',
      'issue_date',
      'issuing_state',
      'last_name',
    ]);
    expect(JSON.stringify(result.reading)).not.toMatch(/R7392041|1989-07-22/);
    expect(result.reading.veteran).toMatchObject({ barcode: 'yes', front: 'no' });
    expect(result.reading.checks.veteran_designation_agrees).toBe('fail');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${BASE}/api/v1/id-read`);
    const form = sent[0]?.init.body as FormData;
    expect([...form.keys()].sort()).toEqual(['back', 'front']);
  });

  it('outside LOCAL and TEST refuses a back without the marker before any call', async () => {
    const { sent, reader } = answering(200, JSON.stringify(readAnswer()));
    for (const back of ['back-other-iin.jpg', 'back-two-barcodes.jpg'] as const) {
      expect(await reader.read({ front: images.front, back: licenceFixture(back) })).toEqual({
        status: 'NOT_SYNTHETIC',
      });
    }
    expect(sent).toHaveLength(0);
  });

  it('outside LOCAL and TEST refuses a front that disagrees with the barcode', async () => {
    const answer = readAnswer();
    const withFields = (fields: Record<string, unknown>) =>
      JSON.stringify({
        ...answer,
        licence: { ...answer.licence, fields: { ...answer.licence.fields, ...fields } },
      });
    const agreeingVeteran = {
      veteran: { value: 'yes', source: 'barcode', agreed: true, barcode: 'yes', front: 'yes' },
    };
    const fromBarcode = { issuing_state: { value: 'CA', source: 'barcode', agreed: true } };
    // Scry's sample: the veteran mark disagrees and the state was read from the front only.
    for (const body of [
      JSON.stringify(answer),
      withFields(fromBarcode),
      withFields(agreeingVeteran),
    ]) {
      const { reader } = answering(200, body);
      expect(await reader.read(images)).toEqual({ status: 'NOT_SYNTHETIC' });
    }
    const { reader: agreed } = answering(200, withFields({ ...agreeingVeteran, ...fromBarcode }));
    expect((await agreed.read(images)).status).toBe('READ');
  });

  it('refuses an answer without the synthetic marker outside LOCAL and TEST', async () => {
    for (const marker of [
      { required: false, present: false, iin: null },
      { required: true, present: true, iin: '636014' },
    ]) {
      const { reader } = answering(
        200,
        JSON.stringify({ ...readAnswer(), synthetic_marker: marker }),
      );
      expect(await reader.read(images)).toEqual({
        status: 'UNAVAILABLE',
        failureClass: 'PROVIDER_RESPONSE_INVALID',
      });
    }
  });

  it('treats any field outside the minimized schema as an invalid response', async () => {
    const answer = readAnswer();
    const withAddress = {
      ...answer,
      licence: {
        ...answer.licence,
        fields: {
          ...answer.licence.fields,
          address_street: { value: '1 X', source: 'front', agreed: true },
        },
      },
    };
    const extraTop = { ...answer, transcript: 'x' };
    for (const body of [withAddress, extraTop]) {
      const { reader } = answering(200, JSON.stringify(body));
      expect(await reader.read(images)).toEqual({
        status: 'UNAVAILABLE',
        failureClass: 'PROVIDER_RESPONSE_INVALID',
      });
    }
  });

  it('maps every non-read answer to a bounded outcome', async () => {
    const cases: [number, string, unknown][] = [
      [
        200,
        JSON.stringify({
          status: 'not_a_licence',
          seconds: 1,
          synthetic_marker: { required: true, present: true, iin: '999999' },
        }),
        { status: 'NOT_A_LICENCE' },
      ],
      [
        200,
        JSON.stringify({ status: 'failed', seconds: 1, message: 'x' }),
        { status: 'UNAVAILABLE', failureClass: 'PROVIDER_UNAVAILABLE' },
      ],
      [422, JSON.stringify({ detail: 'x', code: 'NOT_SYNTHETIC' }), { status: 'NOT_SYNTHETIC' }],
      [
        200,
        JSON.stringify({
          status: 'failed',
          seconds: 1,
          message:
            'The printed front does not match the synthetic barcode, so the card is not shown to be synthetic; nothing was read.',
        }),
        { status: 'NOT_SYNTHETIC' },
      ],
      [
        200,
        JSON.stringify({ status: 'failed', seconds: 1, message: 'FRONT_MISMATCH' }),
        { status: 'NOT_SYNTHETIC' },
      ],
      [
        200,
        JSON.stringify({
          status: 'not_a_licence',
          seconds: 1,
          synthetic_marker: { required: true, present: true, iin: '636014' },
        }),
        { status: 'UNAVAILABLE', failureClass: 'PROVIDER_RESPONSE_INVALID' },
      ],
      [401, '{"detail":"x"}', { status: 'UNAVAILABLE', failureClass: 'AUTHENTICATION_REJECTED' }],
      [404, 'not found', { status: 'UNAVAILABLE', failureClass: 'CONFIGURATION_INVALID' }],
      [413, '{"detail":"x"}', { status: 'UNAVAILABLE', failureClass: 'REQUEST_INVALID' }],
      [503, '{"detail":"busy"}', { status: 'UNAVAILABLE', failureClass: 'PROVIDER_UNAVAILABLE' }],
      [200, 'not json', { status: 'UNAVAILABLE', failureClass: 'PROVIDER_RESPONSE_INVALID' }],
    ];
    for (const [status, body, expected] of cases) {
      const { reader } = answering(status, body);
      expect(await reader.read(images), `${status} ${body}`).toEqual(expected);
    }
  });

  it('fails closed with no call when unconfigured, and maps a timeout', async () => {
    const { sent } = answering(200, '{}');
    const unconfigured = new ScryLicenceReader({
      baseUrl: BASE,
      apiToken: undefined,
      requireMarker: true,
      transport: { fetch: () => Promise.reject(new Error('no call expected')) },
    });
    expect(await unconfigured.read(images)).toEqual({
      status: 'UNAVAILABLE',
      failureClass: 'CONFIGURATION_INVALID',
    });
    expect(sent).toHaveLength(0);

    const slow = new ScryLicenceReader({
      baseUrl: BASE,
      apiToken: 'tok',
      requireMarker: true,
      syntheticIin: '999999',
      timeoutMs: 5,
      transport: {
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
          }),
      },
    });
    expect(await slow.read(images)).toEqual({ status: 'UNAVAILABLE', failureClass: 'TIMEOUT' });
  });
});

describe('licence upload hardening', () => {
  it('re-encodes to a baseline JPEG without EXIF, GPS or comments', () => {
    const upload = licenceFixture('exif.jpg');
    const asText = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');
    expect(asText(upload)).toContain('Exif');
    expect(asText(upload)).toContain('synthetic-comment');

    const stored = hardenLicenceImage(upload);
    expect(asText(stored)).not.toContain('Exif');
    expect(asText(stored)).not.toContain('synthetic-comment');
    expect(asText(stored)).not.toContain('SyntheticCam');
    expect(readJpegFrame(stored)).toEqual({ marker: 0xc0, width: 64, height: 48 });
    expect(
      (jpeg.decode(stored, { useTArray: true }) as { exifBuffer?: unknown }).exifBuffer,
    ).toBeUndefined();
  });

  it('refuses from the header before decoding: size, pixels and non-JPEG', () => {
    const reason = (bytes: Uint8Array) => {
      try {
        hardenLicenceImage(bytes);
        return 'accepted';
      } catch (error) {
        return error instanceof LicenceImageRejectedError ? error.reason : 'other';
      }
    };
    expect(reason(testJpeg(2000, 1200))).toBe('accepted');
    expect(reason(testJpeg(2001, 100))).toBe('too_many_pixels');
    expect(reason(Uint8Array.from(Buffer.from('not a jpeg')))).toBe('not_jpeg');
    expect(reason(new Uint8Array(1_000_001).fill(0xff))).toBe('too_large');
    // Cut before the scan: no frame and scan header. Cut inside the scan: the decode fails.
    const whole = testJpeg(100, 100);
    const scan = Buffer.from(whole).indexOf(Buffer.from([0xff, 0xda]));
    expect(reason(whole.slice(0, 400))).toBe('not_jpeg');
    expect(reason(whole.slice(0, scan + 4))).toBe('undecodable');
  });

  it('refuses a second frame header and a decoded size that differs from the header', () => {
    const original = testJpeg(100, 80);
    const sof = Buffer.from(original).indexOf(Buffer.from([0xff, 0xc0]));
    const length = ((original[sof + 2] ?? 0) << 8) | (original[sof + 3] ?? 0);
    const segment = original.slice(sof, sof + 2 + length);
    const twoFrames = Uint8Array.from([
      ...original.slice(0, sof),
      ...segment,
      ...original.slice(sof),
    ]);
    expect(readJpegFrame(twoFrames)).toBeUndefined();
    expect(() => hardenLicenceImage(twoFrames)).toThrow(LicenceImageRejectedError);

    const frame = { marker: 0xc0, width: 100, height: 80 };
    expect(decodedMatchesFrame(frame, { width: 100, height: 80 })).toBe(true);
    expect(decodedMatchesFrame(frame, { width: 100, height: 81 })).toBe(false);
    expect(decodedMatchesFrame({ ...frame, width: 2001 }, { width: 2001, height: 80 })).toBe(false);
  });
});

describe('synthetic barcode check', () => {
  it('passes only exactly one AAMVA PDF417 carrying the configured IIN', () => {
    expect(readPdf417Payloads(licenceFixture('back-synthetic.jpg'))).toHaveLength(1);
    expect(hasSyntheticMarker(licenceFixture('back-synthetic.jpg'), '999999')).toBe(true);
    expect(hasSyntheticMarker(licenceFixture('back-other-iin.jpg'), '999999')).toBe(false);
    expect(hasSyntheticMarker(testJpeg(), '999999')).toBe(false);
    expect(hasSyntheticMarker(licenceFixture('back-synthetic.jpg'), undefined)).toBe(false);
    // Two PDF417 regions (the marker beside a real-looking one) fail the scan outright.
    expect(readPdf417Payloads(licenceFixture('back-two-barcodes.jpg'))).toBeUndefined();
    expect(hasSyntheticMarker(licenceFixture('back-two-barcodes.jpg'), '999999')).toBe(false);
    // A non-AAMVA PDF417 carrying the marker header inside its payload.
    expect(readPdf417Payloads(licenceFixture('back-marker-in-body.jpg'))).toHaveLength(1);
    expect(hasSyntheticMarker(licenceFixture('back-marker-in-body.jpg'), '999999')).toBe(false);
    // The marker header with no licence number, names or birth date.
    expect(hasSyntheticMarker(licenceFixture('back-marker-only.jpg'), '999999')).toBe(false);
  });
});
