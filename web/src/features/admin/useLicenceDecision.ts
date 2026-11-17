import { useState } from 'react';
import { useSingleFlight } from '../../lib/single-flight';
import { useAdminLicenceReview, useLicenceCommand } from './licence-api';
import type { DeclineReason, RevokeReason } from './licence-labels';

type LicenceDialog =
  'approve' | 'confirm' | 'decline' | 'recuse' | 'revoke' | 'revoke_conflict' | null;

/**
 * The licence review page's state: the review, the commands on it and on a conflicting review,
 * the designation answer, which confirm dialog is open and the reason chosen in it.
 */
export function useLicenceDecision(id: string) {
  const command = useLicenceCommand(id);
  // A recuse drops this review from the cache and the server now answers 403 for it, so the
  // page must not read it again while it leaves for the queue.
  const recused = command.isSuccess && command.variables.name === 'recuse';
  const query = useAdminLicenceReview(id, !recused);
  const conflictId = query.data?.conflicting_review?.review_id ?? '';
  const conflictCommand = useLicenceCommand(conflictId);
  const flight = useSingleFlight();
  const [designation, setDesignation] = useState<'yes' | 'no' | null>(null);
  const [dialog, setDialog] = useState<LicenceDialog>(null);
  const [reason, setReason] = useState<DeclineReason | ''>('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [revokeReason, setRevokeReason] = useState<RevokeReason | ''>('');

  const close = () => {
    setDialog(null);
    setReasonError(undefined);
    command.reset();
    conflictCommand.reset();
  };
  const run = (action: () => Promise<unknown>) =>
    flight(async () => {
      try {
        await action();
        setDialog(null);
      } catch {
        // The dialog shows the plain-words error.
      }
    });

  const answerDesignation = (value: string) => {
    if (value === 'no') {
      setDesignation('no');
      setReason('NO_VETERAN_DESIGNATION');
      setDialog('decline');
    } else setDesignation('yes');
  };

  return {
    query,
    command,
    conflictCommand,
    pending: command.isPending || conflictCommand.isPending,
    designation,
    setDesignation,
    answerDesignation,
    dialog,
    setDialog,
    reason,
    setReason,
    reasonError,
    setReasonError,
    revokeReason,
    setRevokeReason,
    close,
    run,
  };
}

export type LicenceDecision = ReturnType<typeof useLicenceDecision>;
