import { useState } from 'react';
import { useSingleFlight } from '../../lib/single-flight';
import { useAdminLicenceReview, useLicenceCommand } from './licence-api';
import type { DeclineReason, RevokeReason } from './licence-labels';

type LicenceDialog =
  'approve' | 'confirm' | 'decline' | 'recuse' | 'revoke' | 'revoke_conflict' | null;

/** The admin's answer to "Can you see the Veteran designation?" (L5.2). */
export type Designation = 'yes' | 'no';

export const isDesignation = (value: string): value is Designation =>
  value === 'yes' || value === 'no';

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
  const [designation, setDesignation] = useState<Designation | null>(null);
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
      } catch (error) {
        // The mutation keeps the error and its dialog shows it (licenceCommandError); catching
        // here only keeps that dialog open for a retry. Dev builds also log it for debugging.
        if (import.meta.env.DEV) console.debug('Licence command failed', error);
      }
    });

  // Only a real 'yes' may reveal the reading, so anything else that slips past the type is ignored.
  const answerDesignation = (value: Designation) => {
    if (!isDesignation(value)) return;
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
