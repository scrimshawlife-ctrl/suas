import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConsentGrant } from './api';
import {
  consentText,
  findRedAlertGrant,
  RED_ALERT_PURPOSE,
  RED_ALERT_TEMPLATE_PURPOSE,
  redAlertGrantBody,
} from './red-alert-consent';

const VERSION = 'red-alert-trusted-contact@2';

function grant(overrides: Partial<ConsentGrant>): ConsentGrant {
  return {
    consent_grant_id: 'g1',
    permission: 'can_receive',
    scope: 'RED',
    purpose: RED_ALERT_PURPOSE,
    grantee_type: 'TRUSTED_CONTACT',
    grantee_id: 'tc-1',
    consent_template_version: VERSION,
    status: 'ACTIVE',
    granted_at: '2026-11-04T10:00:00Z',
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe('RED alert consent grant', () => {
  it('builds the grant red-alert.ts looks for: can_receive, RED, TRUSTED_CONTACT, the contact row id', () => {
    const body = redAlertGrantBody('tc-1', VERSION);
    expect(body).toEqual({
      permission: 'can_receive',
      scope: 'RED',
      purpose: RED_ALERT_PURPOSE,
      grantee_type: 'TRUSTED_CONTACT',
      grantee_id: 'tc-1',
      consent_template_version: VERSION,
    });
  });

  it('looks up the template key the server publishes for the RED alert', () => {
    const source = readFileSync(resolve(process.cwd(), '../src/consent/templates.ts'), 'utf8');
    expect(source).toContain(`RED_ALERT_CONSENT_TEMPLATE_KEY = '${RED_ALERT_TEMPLATE_PURPOSE}'`);
  });

  it('uses the same purpose wording as the server-side alert', () => {
    const source = readFileSync(resolve(process.cwd(), '../src/signals/red-alert.ts'), 'utf8');
    expect(source).toContain(`const RED_ALERT_PURPOSE = '${RED_ALERT_PURPOSE}'`);
  });

  it('finds only an ACTIVE grant of that exact kind for that contact', () => {
    expect(findRedAlertGrant([grant({})], 'tc-1')?.consent_grant_id).toBe('g1');
    expect(findRedAlertGrant([grant({})], 'tc-2')).toBeUndefined();
    expect(findRedAlertGrant([grant({ status: 'REVOKED' })], 'tc-1')).toBeUndefined();
    expect(findRedAlertGrant([grant({ scope: 'ORANGE' })], 'tc-1')).toBeUndefined();
    expect(findRedAlertGrant([grant({ grantee_type: 'USER' })], 'tc-1')).toBeUndefined();
  });
});

describe('consentText (R12.3)', () => {
  const template = {
    version_key: 'red-alert-trusted-contact@1',
    template_key: RED_ALERT_TEMPLATE_PURPOSE,
    version: 1,
    published_at: '2026-11-04T09:00:00Z',
  };

  it('is the trimmed body, or null when there is no text to confirm', () => {
    expect(consentText({ ...template, body: '  Text.\n' })).toBe('Text.');
    expect(consentText({ ...template, body: ' ' })).toBeNull();
    expect(consentText({ ...template, body: null })).toBeNull();
    expect(consentText(undefined)).toBeNull();
  });
});
