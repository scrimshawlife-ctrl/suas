import type { ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { AlertCircleIcon } from './icons';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  pending: boolean;
  /** Plain-words failure from the last attempt. */
  error?: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Asks the person to confirm an action before it runs. While `pending`, both buttons are disabled
 * and the dialog cannot be dismissed; `error` shows why the last attempt failed.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  pending,
  error,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={pending ? () => undefined : onClose} title={title}>
      <div className="flex flex-col gap-3">{children}</div>
      {error ? (
        <p role="alert" className="flex items-start gap-2 font-bold">
          <AlertCircleIcon className="mt-1 shrink-0" />
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button onClick={onConfirm} disabled={pending}>
          {pending ? 'Working…' : confirmLabel}
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={pending}>
          {cancelLabel}
        </Button>
      </div>
    </Dialog>
  );
}
