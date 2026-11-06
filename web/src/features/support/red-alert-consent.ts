import type { ConsentGrant, GrantConsentBody } from './api';

/**
 * The consent template version the RED-alert grant cites. The API requires a PUBLISHED
 * template (POST /consents answers 422 CONSENT_TEMPLATE_UNAVAILABLE otherwise) and offers no
 * way to look one up. This is the key the local seed publishes; other environments need the
 * backend to publish one and expose it. Decision: the user left this as a known gap.
 */
export const RED_ALERT_TEMPLATE_VERSION = 'local-seed-consent@1';

/** Same wording as src/signals/red-alert.ts (RED_ALERT_PURPOSE). */
export const RED_ALERT_PURPOSE = 'Alert a trusted contact at red';

/**
 * The grant src/signals/red-alert.ts looks for before it queues an alert: `can_receive` on
 * scope `RED`, to a TRUSTED_CONTACT whose id is the trusted contact row id (not the contact's
 * user id).
 */
export function redAlertGrantBody(trustedContactId: string): GrantConsentBody {
  return {
    permission: 'can_receive',
    scope: 'RED',
    purpose: RED_ALERT_PURPOSE,
    grantee_type: 'TRUSTED_CONTACT',
    grantee_id: trustedContactId,
    consent_template_version: RED_ALERT_TEMPLATE_VERSION,
  };
}

/** The ACTIVE RED-alert grant for one trusted contact, if there is one. */
export function findRedAlertGrant(
  grants: readonly ConsentGrant[],
  trustedContactId: string,
): ConsentGrant | undefined {
  return grants.find(
    (grant) =>
      grant.status === 'ACTIVE' &&
      grant.permission === 'can_receive' &&
      grant.scope === 'RED' &&
      grant.grantee_type === 'TRUSTED_CONTACT' &&
      grant.grantee_id === trustedContactId,
  );
}
