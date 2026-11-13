import { hasApiCode, isApiError } from '../../api/errors';
import { useIdempotencyKey } from '../../api/idempotency';
import { useSingleFlight } from '../../lib/single-flight';
import {
  useGrantConsent,
  usePublishedConsentTemplate,
  useRevokeConsent,
  type ConsentGrant,
  type TrustedContact,
} from './api';
import { ErrorNotice } from './errors';
import {
  findRedAlertGrant,
  RED_ALERT_TEMPLATE_PURPOSE,
  redAlertGrantBody,
} from './red-alert-consent';

export const ALERT_LABEL =
  'Send this person a notice from SUAS after a Check-In shows you need support right away.';
export const ALERT_ON = 'On. The notice does not say why.';
export const ALERT_OFF = 'Off. This person will not get a notice.';
export const ALERT_UNAVAILABLE = 'Alerts cannot be turned on in this environment yet.';

/**
 * The switch-like control that creates or ends the RED-alert grant for one accepted contact.
 * It stays focusable while saving (aria-disabled) and ignores changes until the save ends.
 * The Idempotency-Key is kept across retries and renewed only after a success.
 */
export function AlertToggle({
  contact,
  grants,
}: {
  contact: TrustedContact;
  grants: readonly ConsentGrant[] | undefined;
}) {
  const template = usePublishedConsentTemplate(RED_ALERT_TEMPLATE_PURPOSE);
  const grant = useGrantConsent();
  const revoke = useRevokeConsent();
  const key = useIdempotencyKey();
  const flight = useSingleFlight();
  const active = grants ? findRedAlertGrant(grants, contact.trusted_contact_id) : undefined;
  const pending = grant.isPending || revoke.isPending;
  // No published template (404) or one superseded since it was read (422): turning on fails.
  const noTemplate =
    template.isError && isApiError(template.error) && template.error.status === 404;
  const unavailable = noTemplate || hasApiCode(grant.error, 'CONSENT_TEMPLATE_UNAVAILABLE');
  const error = grant.error ?? revoke.error;

  function onChange(next: boolean) {
    if (pending || grants === undefined || template.isPending) return;
    flight(async () => {
      grant.reset();
      revoke.reset();
      const done = { onSuccess: () => key.renew() };
      if (next) {
        const version = template.data?.version_key;
        if (version === undefined) return;
        await grant.mutateAsync(
          { body: redAlertGrantBody(contact.trusted_contact_id, version), headers: key.headers() },
          {
            ...done,
            onError: (error) => {
              if (hasApiCode(error, 'CONSENT_TEMPLATE_UNAVAILABLE')) void template.refetch();
            },
          },
        );
      } else if (active) {
        await revoke.mutateAsync(
          { consentGrantId: active.consent_grant_id, headers: key.headers() },
          done,
        );
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          role="switch"
          className="mt-0.5 size-6 shrink-0 accent-service-blue"
          checked={active !== undefined}
          aria-disabled={pending || grants === undefined || template.isPending ? true : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="break-words">{ALERT_LABEL}</span>
      </label>
      <p role="status" className="pl-9 text-16 text-slate">
        {pending ? 'Saving…' : active ? ALERT_ON : ALERT_OFF}
      </p>
      {unavailable ? (
        <p role="alert" className="pl-9 font-bold">
          {ALERT_UNAVAILABLE}
        </p>
      ) : error ? (
        <div className="pl-9">
          <ErrorNotice error={error} doing="change this setting" />
        </div>
      ) : null}
    </div>
  );
}
