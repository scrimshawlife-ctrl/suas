import { useRef, useState } from 'react';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { StatusChip } from '../../components/StatusChip';
import { useConsents, useTrustedContacts, type ConsentGrant } from './api';
import { StopSharingDialog } from './StopSharingDialog';
import { describeStatus, describeWhat, describeWho, formatDate, sortGrants } from './consent-model';
import { ErrorNotice } from './errors';

/** Consents: who may see or be told what, with a way to stop. No board. */
export default function ConsentsPage() {
  const consents = useConsents();
  const contacts = useTrustedContacts();
  const [stopping, setStopping] = useState<ConsentGrant | null>(null);
  const grants = sortGrants(consents.data ?? []);
  const listHeading = useRef<HTMLHeadingElement>(null);

  return (
    <Page width="narrow">
      <BackLink to={paths.home}>Back to home</BackLink>
      <div className="flex flex-col gap-2">
        <h1 className="heading text-40 max-sm:text-30">What you share</h1>
        <p className="text-slate">
          These are the things you have agreed to share, and with whom. You can stop sharing at any
          time.
        </p>
      </div>

      <h2 ref={listHeading} tabIndex={-1} className="heading text-26">
        Your choices
      </h2>

      {consents.isPending ? (
        <p role="status" className="text-slate">
          Loading what you share…
        </p>
      ) : consents.isError ? (
        <ErrorNotice
          error={consents.error}
          doing="load what you share"
          onRetry={() => void consents.refetch()}
        />
      ) : grants.length === 0 ? (
        <Card>
          <p className="font-bold">You are not sharing anything right now.</p>
          <p className="text-slate">When you agree to share something, it will be listed here.</p>
        </Card>
      ) : (
        <Card as="div" padding="none">
          <ul className="divide-y divide-line">
            {grants.map((grant) => {
              const status = describeStatus(grant, contacts.data ?? []);
              const who = describeWho(grant, contacts.data ?? []);
              return (
                <li
                  key={grant.consent_grant_id}
                  className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3 p-5"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="font-bold break-words">{who}</p>
                    <p>{describeWhat(grant)}</p>
                    <p className="text-16 text-slate">
                      {grant.status === 'REVOKED' && grant.revoked_at
                        ? `Stopped ${formatDate(grant.revoked_at)}`
                        : `Since ${formatDate(grant.granted_at)}`}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2 max-sm:items-start">
                    <StatusChip kind={status.kind}>{status.label}</StatusChip>
                    {grant.status === 'ACTIVE' ? (
                      <Button size="small" variant="secondary" onClick={() => setStopping(grant)}>
                        Stop sharing
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {stopping ? (
        <StopSharingDialog
          key={stopping.consent_grant_id}
          grant={stopping}
          who={describeWho(stopping, contacts.data ?? [])}
          onClose={() => setStopping(null)}
          onStopped={() => {
            setStopping(null);
            window.setTimeout(() => listHeading.current?.focus(), 0);
          }}
        />
      ) : null}
    </Page>
  );
}
