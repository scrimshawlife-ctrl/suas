import type { ConsentGrant, TrustedContact } from './api';

/** What the grant lets the other person do, in plain words. */
export function describeWhat(grant: Pick<ConsentGrant, 'permission' | 'scope'>): string {
  const key = `${grant.permission}:${grant.scope}`;
  switch (key) {
    case 'can_receive:RED':
      return 'Be told if a Check-In shows you need support right away';
    case 'can_receive:ORANGE':
      return 'Be told if a Check-In shows you could use support soon';
    case 'can_receive:YELLOW':
      return 'Be told if a Check-In shows things have been harder lately';
    case 'can_view:support_signal':
      return 'See the result of your Check-Ins';
    case 'can_view:checkin_answers':
      return 'See your Check-In answers';
    case 'can_view:current_requests':
      return 'See your current requests';
    case 'can_view:location':
      return 'See your location';
    case 'can_share:service_request_fulfillment':
      return 'Share the details needed to carry out your request';
    default:
      return 'Use the information you chose to share';
  }
}

/** Who holds the grant, in plain words. A trusted contact is named by the label you gave. */
export function describeWho(
  grant: Pick<ConsentGrant, 'grantee_type' | 'grantee_id'>,
  contacts: readonly TrustedContact[],
): string {
  switch (grant.grantee_type) {
    case 'TRUSTED_CONTACT': {
      const contact = contacts.find((c) => c.trusted_contact_id === grant.grantee_id);
      return contact ? `Your trusted contact: ${contact.relationship_label}` : 'A trusted contact';
    }
    case 'USER':
      return 'A SUAS member';
    case 'SERVICE_PROVIDER':
      return 'A service provider';
    default:
      return 'SUAS';
  }
}

export type GrantStatusKind = 'ok' | 'off';

export function describeStatus(grant: Pick<ConsentGrant, 'status'>): {
  label: string;
  kind: GrantStatusKind;
} {
  switch (grant.status) {
    case 'ACTIVE':
      return { label: 'Sharing', kind: 'ok' };
    case 'REVOKED':
      return { label: 'Stopped', kind: 'off' };
    default:
      return { label: 'Expired', kind: 'off' };
  }
}

/** Active grants first, then newest first. */
export function sortGrants(grants: readonly ConsentGrant[]): ConsentGrant[] {
  return [...grants].sort((a, b) => {
    const activeA = a.status === 'ACTIVE' ? 0 : 1;
    const activeB = b.status === 'ACTIVE' ? 0 : 1;
    if (activeA !== activeB) return activeA - activeB;
    return b.granted_at.localeCompare(a.granted_at);
  });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Contacts the person can still act on. Removed ones are not listed. */
export function visibleContacts(contacts: readonly TrustedContact[]): TrustedContact[] {
  return contacts.filter(
    (c) => c.status === 'INVITED' || c.status === 'ACCEPTED' || c.status === 'SUSPENDED',
  );
}
