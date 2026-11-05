import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { useIdempotencyKey } from '../../api/idempotency';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { StatusChip, type StatusKind } from '../../components/StatusChip';
import { TextField } from '../../components/TextField';
import {
  useConsents,
  useInviteTrustedContact,
  useTrustedContacts,
  type TrustedContact,
} from './api';
import { ErrorNotice } from './errors';
import { visibleContacts } from './consent-model';
import { AlertToggle } from './AlertToggle';
import { RemoveContactDialog } from './RemoveContactDialog';

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

/** Trusted contacts: add, list, remove, and choose who may be alerted. No board. */
export default function TrustedContactsPage() {
  const contacts = useTrustedContacts();
  const consents = useConsents();
  const [removing, setRemoving] = useState<TrustedContact | null>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
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
        <h2 id="your-contacts" ref={listHeading} tabIndex={-1} className="heading text-26">
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
                      <div className="flex min-w-0 flex-wrap items-center gap-3">
                        <p className="min-w-0 text-20 font-bold break-words">
                          {contact.relationship_label}
                        </p>
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
                        {contact.status === 'SUSPENDED'
                          ? 'Alerts are paused for this contact.'
                          : 'You can choose whether to alert this person once they have accepted.'}
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
        <RemoveContactDialog
          key={removing.trusted_contact_id}
          contact={removing}
          grants={consents.data}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            window.setTimeout(() => listHeading.current?.focus(), 0);
          }}
        />
      ) : null}
    </Page>
  );
}
