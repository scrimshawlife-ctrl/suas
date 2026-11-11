import { useIdempotencyKey } from '../../api/idempotency';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { useSingleFlight } from '../../lib/single-flight';
import { useRemoveTrustedContact, type ConsentGrant, type TrustedContact } from './api';
import { ErrorNotice } from './errors';
import { findRedAlertGrant } from './red-alert-consent';

/** Confirm before removing a contact. Any ACTIVE RED-alert grant to them is revoked first. */
export function RemoveContactDialog({
  contact,
  grants,
  onClose,
  onRemoved,
}: {
  contact: TrustedContact;
  grants: readonly ConsentGrant[] | undefined;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const remove = useRemoveTrustedContact();
  const flight = useSingleFlight();
  const revokeKey = useIdempotencyKey();
  const removeKey = useIdempotencyKey();
  return (
    <Dialog open onClose={onClose} title={`Remove ${contact.relationship_label}?`}>
      <p>They will no longer be sent anything. You can add them again later.</p>
      {remove.isError ? <ErrorNotice error={remove.error} doing="remove this person" /> : null}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={remove.isPending}
          onClick={() =>
            flight(() =>
              remove.mutateAsync(
                {
                  trustedContactId: contact.trusted_contact_id,
                  redGrantId: grants
                    ? findRedAlertGrant(grants, contact.trusted_contact_id)?.consent_grant_id
                    : undefined,
                  revokeHeaders: revokeKey.headers(),
                  removeHeaders: removeKey.headers(),
                },
                {
                  onSuccess: () => {
                    revokeKey.renew();
                    removeKey.renew();
                    onRemoved();
                  },
                },
              ),
            )
          }
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
