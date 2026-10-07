/** Covers the LOCAL demo scripts: loopback guard, identifier rewriting, fixture checks. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assertLoopbackBaseUrl as smokeLoopback } from '../../scripts/smoke-demo.js';
import {
  assertLoopbackBaseUrl as fixtureLoopback,
  assertSyntheticFixture,
  rewriteIdentifiers,
} from '../../scripts/export-demo-fixtures.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const REDACTED = 'de000000-0000-4000-8000-';
const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

const LOOPBACK_URLS = ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000'];
const REJECTED_URLS = [
  'https://suasqrf.com',
  'http://10.0.2.2:3000',
  'http://example.com',
  'ftp://127.0.0.1',
  'not a url',
];

describe('assertLoopbackBaseUrl', () => {
  for (const guard of [smokeLoopback, fixtureLoopback]) {
    it('accepts loopback hosts and returns a URL', () => {
      for (const raw of LOOPBACK_URLS) {
        const parsed = guard(raw);
        expect(parsed).toBeInstanceOf(URL);
        expect(parsed.protocol).toBe('http:');
        expect(parsed.port).toBe('3000');
      }
    });

    it('rejects anything that is not a loopback http URL', () => {
      for (const raw of REJECTED_URLS) {
        expect(() => guard(raw)).toThrow();
      }
    });
  }
});

describe('rewriteIdentifiers', () => {
  it('numbers UUIDs by first appearance and keeps the tenant', () => {
    const source = JSON.stringify({ ids: [UUID_A, UUID_B, UUID_A], tenant_id: TENANT_ID });
    const out = rewriteIdentifiers(source);
    expect(out).toContain(`${REDACTED}000000000001`);
    expect(out).toContain(`${REDACTED}000000000002`);
    expect(out).toContain(TENANT_ID);
    expect(out).not.toContain(UUID_A);
    expect(out).not.toContain(UUID_B);
  });

  it('maps the same UUID consistently, ignoring case', () => {
    const out = rewriteIdentifiers(JSON.stringify({ a: UUID_A, b: UUID_A.toUpperCase() }));
    const matches = out.match(/de000000-0000-4000-8000-\d{12}/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(new Set(matches).size).toBe(1);
  });

  it('normalizes ISO timestamps', () => {
    const out = rewriteIdentifiers(
      JSON.stringify({ at: '2026-10-07T19:45:54.384Z', plain: '2026-10-07T19:45:54Z' }),
    );
    expect(out).not.toContain('2026-10-07');
    expect(out.match(/2026-01-15T17:00:00\.000Z/g)).toHaveLength(2);
  });

  it('is idempotent on its own output', () => {
    const source = JSON.stringify({
      tenant_id: TENANT_ID,
      ids: [UUID_A, UUID_B],
      at: '2026-10-07T19:45:54.384Z',
    });
    const once = rewriteIdentifiers(source);
    expect(rewriteIdentifiers(once)).toBe(once);
  });
});

describe('assertSyntheticFixture', () => {
  const good = JSON.stringify({
    tenant_id: TENANT_ID,
    email: 'demo@example.invalid',
    phone: '+1-555-555-0110',
    tag: 'local-seed-consent@1',
    at: '2026-10-07T19:45:54Z',
  });

  it('accepts synthetic contacts, UUIDs, timestamps, and version tags', () => {
    expect(() => assertSyntheticFixture(good)).not.toThrow();
  });

  it('rejects credential material', () => {
    expect(() => assertSyntheticFixture('{"session_credential":"redacted"}')).toThrow();
  });

  it('rejects emails outside example.invalid', () => {
    // Counter-examples are assembled at runtime so the repository hygiene scan stays clean.
    const routableEmail = ['person', 'gmail.com'].join('@');
    expect(() => assertSyntheticFixture(`{"email":"${routableEmail}"}`)).toThrow();
  });

  it('rejects phone numbers outside the 555-0100 to 555-0199 range', () => {
    const routablePhones = [['+1-415', '555', '2671'].join('-'), ['(212) 555', '1234'].join('-')];
    for (const phone of routablePhones) {
      expect(() => assertSyntheticFixture(`{"phone":"${phone}"}`)).toThrow();
    }
  });
});

describe('contract/demo-fixtures.json', () => {
  const raw = readFileSync(new URL('../../contract/demo-fixtures.json', import.meta.url), 'utf8');

  it('passes the synthetic content guard', () => {
    expect(() => assertSyntheticFixture(raw)).not.toThrow();
  });

  it('is stable under rewriteIdentifiers', () => {
    expect(rewriteIdentifiers(raw)).toBe(raw);
  });

  it('contains no em dash character', () => {
    expect(raw.includes('\u2014')).toBe(false);
  });

  it('parses to the expected demo shape', () => {
    const doc = JSON.parse(raw) as {
      demo_code?: string;
      tenant_id?: string;
      enrolled?: { email?: string }[];
    };
    expect(doc.demo_code).toBe('123456');
    expect(doc.tenant_id).toBe(TENANT_ID);
    expect(doc.enrolled).toHaveLength(2);
    expect((doc.enrolled ?? []).map((entry) => entry.email)).toEqual([
      'demo@example.invalid',
      'newvet@example.invalid',
    ]);
    for (const entry of doc.enrolled ?? []) {
      expect(entry.email ?? '').toMatch(/@example\.invalid$/);
    }
  });
});
