import { describe, expect, it } from 'vitest';
import type { ConsentGrant } from './api';
import {
  findRedAlertGrant,
  RED_ALERT_PURPOSE,
  RED_ALERT_TEMPLATE_VERSION,
  redAlertGrantBody,
} from './red-alert-consent';

function grant(overrides: Partial<ConsentGrant>): ConsentGrant {
  return {
    consent_grant_id: 'g1',
    permission: 'can_receive',
    scope: 'RED',
    purpose: RED_ALERT_PURPOSE,
    grantee_type: 'TRUSTED_CONTACT',
    grantee_id: 'tc-1',
    consent_template_version: RED_ALERT_TEMPLATE_VERSION,
    status: 'ACTIVE',
    granted_at: '2026-11-04T10:00:00Z',
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe('RED alert consent grant', () => {
  it('matches what src/signals/red-alert.ts checks: can_receive, RED, TRUSTED_CONTACT, contact row id', () => {
    expect(redAlertGrantBody('tc-1')).toEqual({
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'Alert a trusted contact at red',
      grantee_type: 'TRUSTED_CONTACT',
      grantee_id: 'tc-1',
      consent_template_version: 'local-seed-consent@1',
    });
  });

  it('finds only an ACTIVE grant of that exact kind for that contact', () => {
    expect(findRedAlertGrant([grant({})], 'tc-1')?.consent_grant_id).toBe('g1');
    expect(findRedAlertGrant([grant({})], 'tc-2')).toBeUndefined();
    expect(findRedAlertGrant([grant({ status: 'REVOKED' })], 'tc-1')).toBeUndefined();
    expect(findRedAlertGrant([grant({ scope: 'ORANGE' })], 'tc-1')).toBeUndefined();
    expect(findRedAlertGrant([grant({ grantee_type: 'USER' })], 'tc-1')).toBeUndefined();
  });
});
