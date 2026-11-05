import { describe, expect, it } from 'vitest';
import type { ConsentGrant, TrustedContact } from './api';
import { describeStatus, describeWhat, visibleContacts } from './consent-model';

const grant = {
  permission: 'can_receive',
  scope: 'RED',
  grantee_type: 'TRUSTED_CONTACT',
  grantee_id: 'tc-1',
  status: 'ACTIVE',
} as ConsentGrant;

function contact(status: TrustedContact['status']): TrustedContact {
  return {
    trusted_contact_id: 'tc-1',
    relationship_label: 'Sister',
    status,
    contact_user_id: null,
  };
}

describe('consent model', () => {
  it('describes the RED grant as a notice from SUAS, without saying why', () => {
    expect(describeWhat(grant)).toBe(
      'Get a notice from SUAS after a Check-In shows you need support right away',
    );
  });

  it('calls an ACTIVE grant to a removed or revoked contact "Not in effect"', () => {
    expect(describeStatus(grant, [contact('ACCEPTED')]).label).toBe('Sharing');
    expect(describeStatus(grant, [contact('REMOVED')])).toEqual({
      label: 'Not in effect',
      kind: 'off',
    });
    expect(describeStatus(grant, [contact('REVOKED')]).label).toBe('Not in effect');
    expect(describeStatus({ ...grant, status: 'REVOKED' }, []).label).toBe('Stopped');
  });

  it('lists only contacts the person can still act on', () => {
    const all = (['INVITED', 'ACCEPTED', 'SUSPENDED', 'REMOVED', 'REVOKED'] as const).map(contact);
    expect(visibleContacts(all).map((c) => c.status)).toEqual(['INVITED', 'ACCEPTED', 'SUSPENDED']);
  });
});
