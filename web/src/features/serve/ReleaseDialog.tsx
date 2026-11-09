import { useState } from 'react';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { TextArea } from '../../components/TextArea';
import { useReleaseRequest } from './api';
import { RELEASE_REASON_MAX, commandErrorMessage } from './case-logic';

export interface ReleaseDialogProps {
  serviceRequestId: string;
  onClose: () => void;
  onReleased: () => void;
}

/** Asks the helper for a required reason, then hands the request back to the open list. */
export function ReleaseDialog({ serviceRequestId, onClose, onReleased }: ReleaseDialogProps) {
  const [reason, setReason] = useState('');
  const release = useReleaseRequest(serviceRequestId);
  const trimmed = reason.trim();

  return (
    <Dialog open onClose={onClose} title="Release this request?">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === '' || release.isPending) return;
          release.mutate(trimmed, { onSuccess: onReleased });
        }}
      >
        <p>
          It goes back to the open list for someone else to take. Your chat with the requester
          closes.
        </p>
        <TextArea
          label="Why are you releasing it?"
          required
          maxLength={RELEASE_REASON_MAX}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
          }}
        />
        {release.isError ? (
          <p role="alert" className="font-bold">
            {commandErrorMessage(release.error)}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button type="submit" disabled={trimmed === '' || release.isPending}>
            {release.isPending ? 'Releasing…' : 'Confirm release'}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
