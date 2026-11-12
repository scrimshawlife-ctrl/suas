import type { ConsentGrant, GrantConsentBody } from './api';

/**
 * Template key of the RED-alert consent, as src/consent/templates.ts names it. The grant cites
 * the version GET /consent-templates/published?purpose= returns, which a SUAS admin publishes
 * (R9.3, contributor proposal, specs #72).
 */
export const RED_ALERT_TEMPLATE_PURPOSE = 'red-alert-trusted-contact';

/** Same wording as src/signals/red-alert.ts (RED_ALERT_PURPOSE). */
export const RED_ALERT_PURPOSE = 'Alert a trusted contact at red';

/**
 * The grant src/signals/red-alert.ts looks for before it queues an alert: `can_receive` on
 * scope `RED`, to a TRUSTED_CONTACT whose id is the trusted contact row id (not the contact's
 * user id).
 */
export function redAlertGrantBody(
  trustedContactId: string,
  templateVersion: string,
): GrantConsentBody {
  return {
    permission: 'can_receive',
    scope: 'RED',
    purpose: RED_ALERT_PURPOSE,
    grantee_type: 'TRUSTED_CONTACT',
    grantee_id: trustedContactId,
    consent_template_version: templateVersion,
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
