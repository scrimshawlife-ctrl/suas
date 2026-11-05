import { useIdempotencyKey } from '../../api/idempotency';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { useRevokeConsent, type ConsentGrant } from './api';
import { describeWhat } from './consent-model';
import { ErrorNotice } from './errors';

/** Confirm before revoking one grant. `onClose` is Keep or Escape; `onStopped` follows success. */
export function StopSharingDialog({
  grant,
  who,
  onClose,
  onStopped,
}: {
  grant: ConsentGrant;
  who: string;
  onClose: () => void;
  onStopped: () => void;
}) {
  const key = useIdempotencyKey();
  const revoke = useRevokeConsent();
  return (
    <Dialog open onClose={onClose} title="Stop sharing?">
      <div className="flex flex-col gap-1">
        <p className="font-bold break-words">{who}</p>
        <p>{describeWhat(grant)}</p>
      </div>
      <p>This stops right away. You can share again later.</p>
      {revoke.isError ? <ErrorNotice error={revoke.error} doing="stop sharing" /> : null}
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={revoke.isPending}
          onClick={() =>
            revoke.mutate(
              { consentGrantId: grant.consent_grant_id, headers: key.headers() },
              {
                onSuccess: () => {
                  key.renew();
                  onStopped();
                },
              },
            )
          }
        >
          {revoke.isPending ? 'Stopping…' : 'Stop sharing'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Keep sharing
        </Button>
      </div>
    </Dialog>
  );
}
