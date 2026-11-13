import { useState } from 'react';
import { hasApiCode, isApiError } from '../../api/errors';
import { useIdempotencyKey } from '../../api/idempotency';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
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
  consentText,
  findRedAlertGrant,
  RED_ALERT_TEMPLATE_PURPOSE,
  redAlertGrantBody,
} from './red-alert-consent';

export const ALERT_LABEL =
  'Send this person a notice from SUAS after a Check-In shows you need support right away.';
export const ALERT_ON = 'On. The notice does not say why.';
export const ALERT_OFF = 'Off. This person will not get a notice.';
export const ALERT_UNAVAILABLE = 'Alerts cannot be turned on in this environment yet.';

/** The template version the Veteran is reading, and so the one the grant will cite. */
interface Confirming {
  version: string;
  text: string;
}

/**
 * Creates or ends the RED-alert grant for one contact; turning on first shows the published
 * consent text (R12.3). The Idempotency-Key is kept across retries and renewed after a success.
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
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const text = consentText(template.data);
  const active = grants ? findRedAlertGrant(grants, contact.trusted_contact_id) : undefined;
  const pending = grant.isPending || revoke.isPending;
  // No published template (404), one with no text to show, or one superseded since it was
  // read (422): turning on fails.
  const noTemplate =
    template.isError && isApiError(template.error) && template.error.status === 404;
  const unavailable =
    noTemplate ||
    (template.isSuccess && text === null) ||
    hasApiCode(grant.error, 'CONSENT_TEMPLATE_UNAVAILABLE');
  const error = grant.error ?? revoke.error;
  const readFailed = template.isError && !noTemplate;

  function onChange(next: boolean) {
    if (pending || grants === undefined || template.isPending) return;
    grant.reset();
    revoke.reset();
    if (next) {
      // Nothing is sent yet: the grant waits for the Veteran to read and confirm the text.
      if (template.data && text !== null) {
        setConfirming({ version: template.data.version_key, text });
      }
      return;
    }
    if (!active) return;
    flight(() =>
      revoke.mutateAsync(
        { consentGrantId: active.consent_grant_id, headers: key.headers() },
        { onSuccess: () => key.renew() },
      ),
    );
  }

  function onConfirm(version: string) {
    setConfirming(null);
    flight(() =>
      grant.mutateAsync(
        { body: redAlertGrantBody(contact.trusted_contact_id, version), headers: key.headers() },
        {
          onSuccess: () => key.renew(),
          onError: (error) => {
            if (hasApiCode(error, 'CONSENT_TEMPLATE_UNAVAILABLE')) void template.refetch();
          },
        },
      ),
    );
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
      ) : readFailed ? (
        <div className="pl-9">
          <ErrorNotice
            error={template.error}
            doing="load the alert's consent text"
            onRetry={() => void template.refetch()}
          />
        </div>
      ) : null}
      {confirming ? (
        <Dialog open onClose={() => setConfirming(null)} title="Turn on this alert?">
          <p>Read what you agree to. Nothing is turned on until you choose Turn on.</p>
          <p className="rounded-8 border border-line bg-white px-4 py-3 whitespace-pre-line break-words">
            {confirming.text}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => onConfirm(confirming.version)}>Turn on</Button>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
