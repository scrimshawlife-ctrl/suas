import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useIdempotencyKey } from '../../api/idempotency';
import { hasApiCode } from '../../api/errors';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Dialog } from '../../components/Dialog';
import { Page } from '../../components/Page';
import { StatusChip, type StatusKind } from '../../components/StatusChip';
import { TextField } from '../../components/TextField';
import {
  useConsents,
  useGrantConsent,
  useInviteTrustedContact,
  useRemoveTrustedContact,
  useRevokeConsent,
  useTrustedContacts,
  type ConsentGrant,
  type TrustedContact,
} from './api';
import { ErrorNotice } from './errors';
import { visibleContacts } from './consent-model';
import { findRedAlertGrant, redAlertGrantBody } from './red-alert-consent';

const ALERT_LABEL = 'Alert this person if a Check-In shows I need support right away';

const STATUS: Record<string, { label: string; kind: StatusKind }> = {
  INVITED: { label: 'Invited', kind: 'wait' },
  ACCEPTED: { label: 'Accepted', kind: 'ok' },
  SUSPENDED: { label: 'Paused', kind: 'off' },
};

function InviteForm() {
  const invite = useInviteTrustedContact();
  const key = useIdempotencyKey();
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<{ label?: string; email?: string }>({});

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedLabel = label.trim();
    const trimmedEmail = email.trim();
    const next: { label?: string; email?: string } = {};
    if (trimmedLabel === '') next.label = 'Enter who this person is to you.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail))
      next.email = 'Enter a full email address.';
    setProblem(next);
    if (next.label || next.email) return;
    invite.mutate(
      { relationshipLabel: trimmedLabel, email: trimmedEmail, headers: key.headers() },
      {
        onSuccess: () => {
          key.renew();
          setLabel('');
          setEmail('');
        },
      },
    );
  }

  return (
    <Card padding="lg">
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <h2 className="heading text-26">Add a trusted contact</h2>
        <TextField
          label="Who is this to you?"
          helper="For example: sister, battle buddy, friend."
          maxLength={128}
          value={label}
          error={problem.label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <TextField
          label="Their email"
          type="email"
          autoComplete="off"
          value={email}
          error={problem.email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <p className="text-16 text-slate">
          Adding someone does not share anything with them. SUAS does not message them yet, so tell
          them yourself.
        </p>
        {invite.isError ? <ErrorNotice error={invite.error} doing="add this person" /> : null}
        <div role="status">
          {invite.isSuccess ? <p className="font-bold">Added. They are listed below.</p> : null}
        </div>
        <div className="flex">
          <Button type="submit" size="form" disabled={invite.isPending}>
            {invite.isPending ? 'Adding…' : 'Add trusted contact'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** The switch-like control that creates or ends the RED-alert grant for one accepted contact. */
function AlertToggle({
  contact,
  grants,
}: {
  contact: TrustedContact;
  grants: readonly ConsentGrant[] | undefined;
}) {
  const grant = useGrantConsent();
  const revoke = useRevokeConsent();
  const key = useIdempotencyKey();
  const active = grants ? findRedAlertGrant(grants, contact.trusted_contact_id) : undefined;
  const pending = grant.isPending || revoke.isPending;
  const error = grant.error ?? revoke.error;
  const unavailable = hasApiCode(grant.error, 'CONSENT_TEMPLATE_UNAVAILABLE');

  function onChange(next: boolean) {
    grant.reset();
    revoke.reset();
    const done = { onSuccess: () => key.renew() };
    if (next) {
      grant.mutate(
        { body: redAlertGrantBody(contact.trusted_contact_id), headers: key.headers() },
        done,
      );
    } else if (active) {
      revoke.mutate({ consentGrantId: active.consent_grant_id, headers: key.headers() }, done);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex min-h-11 cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          role="switch"
          className="mt-0.5 size-6 shrink-0 accent-service-blue"
          checked={active !== undefined}
          disabled={pending || grants === undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{ALERT_LABEL}</span>
      </label>
      <p role="status" className="pl-9 text-16 text-slate">
        {pending
          ? 'Saving…'
          : active
            ? 'On. This person may be told if a Check-In shows you need support right away.'
            : 'Off. This person will not be told.'}
      </p>
      {unavailable ? (
        <p role="alert" className="pl-9 font-bold">
          Alerts cannot be turned on in this environment yet.
        </p>
      ) : error ? (
        <div className="pl-9">
          <ErrorNotice error={error} doing="change this setting" />
        </div>
      ) : null}
    </div>
  );
}

function RemoveDialog({ contact, onClose }: { contact: TrustedContact; onClose: () => void }) {
  const remove = useRemoveTrustedContact();
  return (
    <Dialog open onClose={onClose} title={`Remove ${contact.relationship_label}?`}>
      <p>They will no longer be told anything. You can add them again later.</p>
      {remove.isError ? <ErrorNotice error={remove.error} doing="remove this person" /> : null}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={remove.isPending}
          onClick={() => remove.mutate(contact.trusted_contact_id, { onSuccess: onClose })}
        >
          {remove.isPending ? 'Removing…' : 'Remove'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Keep
        </Button>
      </div>
    </Dialog>
  );
}

/** Trusted contacts: add, list, remove, and choose who may be alerted. No board. */
export default function TrustedContactsPage() {
  const contacts = useTrustedContacts();
  const consents = useConsents();
  const [removing, setRemoving] = useState<TrustedContact | null>(null);
  const list = visibleContacts(contacts.data ?? []);

  return (
    <Page width="narrow">
      <BackLink to={paths.home}>Back to home</BackLink>
      <div className="flex flex-col gap-2">
        <h1 className="heading text-40 max-sm:text-30">Trusted contacts</h1>
        <p className="text-slate">
          People you trust. You decide what each of them may be told. See everything you share on{' '}
          <Link to={paths.consents}>What you share</Link>.
        </p>
      </div>

      <InviteForm />

      <section aria-labelledby="your-contacts" className="flex flex-col gap-4">
        <h2 id="your-contacts" className="heading text-26">
          Your trusted contacts
        </h2>
        {contacts.isPending ? (
          <p role="status" className="text-slate">
            Loading your trusted contacts…
          </p>
        ) : contacts.isError ? (
          <ErrorNotice
            error={contacts.error}
            doing="load your trusted contacts"
            onRetry={() => void contacts.refetch()}
          />
        ) : list.length === 0 ? (
          <Card>
            <p className="font-bold">You have not added anyone yet.</p>
          </Card>
        ) : (
          <Card as="div" padding="none">
            <ul className="divide-y divide-line">
              {list.map((contact) => {
                const status = STATUS[contact.status] ?? STATUS.INVITED!;
                return (
                  <li key={contact.trusted_contact_id} className="flex flex-col gap-4 p-5">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <p className="text-20 font-bold">{contact.relationship_label}</p>
                        <StatusChip kind={status.kind}>{status.label}</StatusChip>
                      </div>
                      <Button size="small" variant="secondary" onClick={() => setRemoving(contact)}>
                        Remove
                      </Button>
                    </div>
                    {contact.status === 'ACCEPTED' ? (
                      <AlertToggle contact={contact} grants={consents.data} />
                    ) : (
                      <p className="text-16 text-slate">
                        You can choose whether to alert this person once they have accepted.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
        {consents.isError && !contacts.isError ? (
          <ErrorNotice
            error={consents.error}
            doing="load your alert settings"
            onRetry={() => void consents.refetch()}
          />
        ) : null}
      </section>

      {removing ? (
        <RemoveDialog
          key={removing.trusted_contact_id}
          contact={removing}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </Page>
  );
}
