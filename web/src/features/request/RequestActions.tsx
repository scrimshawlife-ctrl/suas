import { useId, useMemo, useState } from 'react';
import { useIdempotencyKey } from '../../api/idempotency';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { useRequestCommand } from './api';
import { requestErrorMessage } from './errors';

/**
 * "Cancel request" and its confirmation. "Keep request active" is the default focus, so a
 * stray Enter never drops a request (QrfStates board).
 */
export function CancelRequest({ requestId }: { requestId: string }) {
  const [open, setOpen] = useState(false);
  const keepId = useId();
  // Button does not forward a ref, so the dialog is handed a ref-shaped lookup by id.
  const keepRef = useMemo(
    () => ({
      get current() {
        return document.getElementById(keepId);
      },
    }),
    [keepId],
  );
  const key = useIdempotencyKey();
  const cancel = useRequestCommand(requestId, 'CANCEL');

  const close = () => {
    if (!cancel.isPending) setOpen(false);
  };
  const confirm = () => {
    cancel.mutate(key.current(), {
      onSuccess: () => {
        key.renew();
        setOpen(false);
      },
    });
  };

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Cancel request
      </Button>
      <Dialog open={open} onClose={close} title="Cancel this request?" initialFocusRef={keepRef}>
        <p>Canceling stops SUAS from seeking additional support for this request.</p>
        <p>
          It does not cancel services that you have already arranged directly with another provider.
        </p>
        {cancel.isError ? <p role="alert">{requestErrorMessage(cancel.error)}</p> : null}
        <div className="mt-1.5 flex flex-wrap gap-2.5">
          <Button id={keepId} onClick={close}>
            Keep request active
          </Button>
          <Button variant="secondary" onClick={confirm} disabled={cancel.isPending}>
            {cancel.isPending ? 'Canceling…' : 'Cancel request'}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** "Confirm it's done": the requester says the need was met (CONFIRM, FULFILLED only). */
export function ConfirmDone({ requestId }: { requestId: string }) {
  const key = useIdempotencyKey();
  const confirm = useRequestCommand(requestId, 'CONFIRM');
  return (
    <div className="flex flex-col gap-2.5">
      <div>
        <Button
          disabled={confirm.isPending}
          onClick={() => confirm.mutate(key.current(), { onSuccess: () => key.renew() })}
        >
          {confirm.isPending ? 'Confirming…' : "Confirm it's done"}
        </Button>
      </div>
      {confirm.isError ? <p role="alert">{requestErrorMessage(confirm.error)}</p> : null}
    </div>
  );
}
