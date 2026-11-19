import { ConfirmDialog } from '../../components/ConfirmDialog';
import { RadioCardGroup } from '../../components/RadioCardGroup';
import { Select } from '../../components/Select';
import {
  DECLINE_REASONS,
  licenceCommandError,
  parseRevokeReason,
  REVOKE_REASONS,
} from './licence-labels';
import type { LicenceApproval } from './licence-api';
import type { LicenceDecision } from './useLicenceDecision';

/** Approve and confirm state that the designation was seen and every by-eye check holds. */
const APPROVAL: LicenceApproval = {
  designation_visible: true,
  checklist: { selfie_matches: true, security_features: true, whole_card: true },
};

/**
 * The licence review page's confirm dialogs: approve, confirm, decline, recuse, and revoke for
 * this review or a conflicting one. `onRecused` runs once a recuse succeeded.
 */
export function LicenceDecisionDialogs({
  decision,
  onRecused,
}: {
  decision: LicenceDecision;
  onRecused: () => void;
}) {
  const {
    query,
    command,
    conflictCommand,
    pending,
    designation,
    setDesignation,
    dialog,
    reason,
    setReason,
    reasonError,
    setReasonError,
    revokeReason,
    setRevokeReason,
    close,
    run,
  } = decision;

  return (
    <>
      <ConfirmDialog
        open={dialog === 'approve'}
        title="Approve this licence?"
        confirmLabel="Approve licence"
        cancelLabel="Cancel"
        pending={pending}
        error={command.isError ? licenceCommandError(command.error) : undefined}
        onConfirm={() => run(() => command.mutateAsync({ name: 'approve', body: APPROVAL }))}
        onClose={close}
      >
        <p>
          This is the first approval. A different admin must confirm it before the person can ask
          for help.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'confirm'}
        title="Confirm this approval?"
        confirmLabel="Confirm approval"
        cancelLabel="Cancel"
        pending={pending}
        error={command.isError ? licenceCommandError(command.error) : undefined}
        onConfirm={() => run(() => command.mutateAsync({ name: 'confirm', body: APPROVAL }))}
        onClose={close}
      >
        <p>This confirms the person's Veteran status, so they can ask for help.</p>
        <p className="text-16 text-slate">
          The images and the reading are deleted when you confirm.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'decline'}
        title="Decline this licence?"
        confirmLabel="Decline licence"
        cancelLabel="Cancel"
        pending={pending}
        error={command.isError ? licenceCommandError(command.error) : undefined}
        onConfirm={() => {
          if (reason === '') {
            setReasonError('Choose a reason.');
            document.getElementById('decline-reason')?.focus();
            return;
          }
          run(() => command.mutateAsync({ name: 'decline', body: { reason } }));
        }}
        onClose={() => {
          close();
          if (designation === 'no') setDesignation(null);
        }}
      >
        <p>The person sees the reason in plain words, and can send new photos or dispute it.</p>
        <Select
          id="decline-reason"
          label="Reason"
          placeholder="Choose a reason"
          options={DECLINE_REASONS}
          value={reason}
          error={reasonError}
          onValueChange={(value) => {
            setReason(value);
            setReasonError(undefined);
          }}
        />
        <p className="text-16 text-slate">
          The images and the reading are deleted when you decline.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'recuse'}
        title="Step back from this review?"
        confirmLabel="Step back"
        cancelLabel="Cancel"
        pending={pending}
        error={command.isError ? licenceCommandError(command.error) : undefined}
        onConfirm={() =>
          run(async () => {
            await command.mutateAsync({ name: 'recuse', body: {} });
            onRecused();
          })
        }
        onClose={close}
      >
        <p>
          For example, if you know the person. The review leaves your queue, and you cannot open or
          decide it again.
        </p>
      </ConfirmDialog>
      {(['revoke', 'revoke_conflict'] as const).map((which) => {
        const target = which === 'revoke' ? command : conflictCommand;
        return (
          <ConfirmDialog
            key={which}
            open={dialog === which}
            title="Revoke this approval?"
            confirmLabel="Revoke approval"
            cancelLabel="Cancel"
            pending={pending}
            error={target.isError ? licenceCommandError(target.error) : undefined}
            onConfirm={() => {
              if (revokeReason === '') {
                setReasonError('Choose a reason.');
                return;
              }
              run(async () => {
                await target.mutateAsync({ name: 'revoke', body: { reason: revokeReason } });
                if (which === 'revoke_conflict') void query.refetch();
              });
            }}
            onClose={close}
          >
            <p>This frees the licence, so it can be approved on another review.</p>
            <RadioCardGroup
              legend="Reason"
              name={`${which}-reason`}
              options={REVOKE_REASONS.map(({ value, label, description }) => ({
                value,
                title: label,
                description,
              }))}
              value={revokeReason}
              onValueChange={(value) => {
                const parsed = parseRevokeReason(value);
                if (parsed === null) return;
                setRevokeReason(parsed);
                setReasonError(undefined);
              }}
            />
            {reasonError && dialog === which ? <p className="font-bold">{reasonError}</p> : null}
          </ConfirmDialog>
        );
      })}
    </>
  );
}
