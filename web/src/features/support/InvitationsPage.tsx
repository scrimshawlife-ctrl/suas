import { useState } from 'react';
import { useIdempotencyKey } from '../../api/idempotency';
import { useMode } from '../../app/mode-store';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { useSingleFlight } from '../../lib/single-flight';
import { useAcceptInvitation, useInvitations, type TrustedContactInvitation } from './api';
import { ErrorNotice } from './errors';

const SOMEONE = 'A veteran';

/** One invitation: who sent it, how they named the relationship, and Accept (its own key). */
function InvitationItem({
  invitation,
  onAccepted,
}: {
  invitation: TrustedContactInvitation;
  onAccepted: () => void;
}) {
  const accept = useAcceptInvitation();
  const key = useIdempotencyKey();
  const flight = useSingleFlight();
  const name = invitation.veteran_display_name ?? SOMEONE;

  return (
    <li className="flex flex-col gap-3 p-5">
      <div className="flex flex-col gap-1">
        <p className="text-20 font-bold break-words">{name}</p>
        <p className="break-words">They listed you as: {invitation.relationship_label}</p>
      </div>
      {accept.isError ? <ErrorNotice error={accept.error} doing="accept this invitation" /> : null}
      <div className="flex">
        <Button
          size="small"
          aria-label={`Accept the invitation from ${name}`}
          disabled={accept.isPending}
          onClick={() =>
            flight(() =>
              accept.mutateAsync(
                { trustedContactId: invitation.trusted_contact_id, headers: key.headers() },
                {
                  onSuccess: () => {
                    key.renew();
                    onAccepted();
                  },
                },
              ),
            )
          }
        >
          {accept.isPending ? 'Accepting…' : 'Accept'}
        </Button>
      </div>
    </li>
  );
}

/**
 * Invitations to be someone's trusted contact (R9.4, contributor proposal, specs #72). Shows
 * the inviting Veteran's display name and the relationship label only. Accepting shares
 * nothing by itself: the Veteran still decides what SUAS may tell this person.
 */
export default function InvitationsPage() {
  const invitations = useInvitations();
  const [accepted, setAccepted] = useState(false);
  const home = useMode() === 'serve' ? paths.serve : paths.home;
  const items = invitations.data ?? [];

  return (
    <Page width="narrow">
      <BackLink to={home}>Back to home</BackLink>
      <div className="flex flex-col gap-2">
        <h1 className="heading text-40 max-sm:text-30">Invitations</h1>
        <p className="text-slate">
          When a veteran adds you as a trusted contact, their invitation shows here. Accepting does
          not share anything with you by itself. They choose separately what SUAS may tell you.
        </p>
      </div>

      <div role="status">
        {accepted ? (
          <p className="font-bold">Accepted. They can now choose what SUAS may tell you.</p>
        ) : null}
      </div>

      {invitations.isPending ? (
        <p role="status" className="text-slate">
          Loading invitations…
        </p>
      ) : invitations.isError ? (
        <ErrorNotice
          error={invitations.error}
          doing="load your invitations"
          onRetry={() => void invitations.refetch()}
        />
      ) : items.length === 0 ? (
        <Card>
          <p className="font-bold">You have no invitations.</p>
        </Card>
      ) : (
        <Card as="div" padding="none">
          <ul className="divide-y divide-line">
            {items.map((invitation) => (
              <InvitationItem
                key={invitation.trusted_contact_id}
                invitation={invitation}
                onAccepted={() => setAccepted(true)}
              />
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
