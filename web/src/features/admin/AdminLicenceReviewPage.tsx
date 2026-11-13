import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useMe } from '../../api/me';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { RadioCardGroup } from '../../components/RadioCardGroup';
import { Select } from '../../components/Select';
import { StatusChip } from '../../components/StatusChip';
import { useSingleFlight } from '../../lib/single-flight';
import { useAdminLicenceReview, useLicenceCommand, type AdminLicenceReview } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import {
  CHECKLIST,
  DECLINE_REASONS,
  declineReasonLabel,
  licenceCommandError,
  licenceLoadError,
  REVOKE_REASONS,
  revokeReasonLabel,
  sentAgo,
  statusChip,
  type ChecklistKey,
  type DeclineReason,
  type RevokeReason,
} from './licence-labels';
import { LicenceReviewImages } from './LicenceReviewImages';
import { ConflictingReview, formatWhen, LicenceReviewReading } from './LicenceReviewReading';
import { QueryNotice } from './QueryNotice';

type Dialog = 'approve' | 'confirm' | 'decline' | 'recuse' | 'revoke' | 'revoke_conflict' | null;

const NO_TICKS: Record<ChecklistKey, boolean> = {
  selfie_matches: false,
  security_features: false,
  whole_card: false,
};

/** Why approval is not possible yet, from the review alone (the server refuses the same, L5.4). */
function approvalBlock(review: AdminLicenceReview): string | null {
  if (review.identity_match !== 'YES')
    return 'The licence does not match the details given to VA, or they were not read, so this cannot be approved. You can decline it.';
  if (review.fingerprint_in_use === null)
    return "The licence number or state wasn't read, so this can't be approved. Decline it instead.";
  if (review.fingerprint_in_use)
    return 'This licence is already approved for another account, so it cannot be approved unless that approval is revoked.';
  return null;
}

/** A decided or unreadable review: its outcome, with no images or reading left (L5.5, L5.7). */
function DecidedRecord({ review }: { review: AdminLicenceReview }) {
  const when = formatWhen(review.decided_at);
  const text =
    review.status === 'APPROVED'
      ? `Approved and confirmed. ${when}. The person can now ask for help.`
      : review.status === 'DECLINED'
        ? `Declined: ${declineReasonLabel(review.decline_reason)}. ${when}.`
        : review.status === 'REVOKED'
          ? `Revoked: ${revokeReasonLabel(review.revoke_reason)}. ${when}.`
          : review.status === 'READING'
            ? 'The reader is still reading this licence. Check back in a minute.'
            : 'The reader could not read this licence. The images were deleted, and the person can send new ones.';
  return (
    <p tabIndex={-1} role="status" className="font-bold">
      {text}
    </p>
  );
}

/**
 * One licence review (L5.2 to L5.8). The three images come first, alone. The designation
 * question gates everything else: "No" goes straight to a decline, "Yes" shows the reading,
 * checks and the by-eye checklist. A first admin approves; a different admin confirms.
 */
export default function AdminLicenceReviewPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const query = useAdminLicenceReview(id);
  const me = useMe();
  const command = useLicenceCommand(id);
  const conflictId = query.data?.conflicting_review?.review_id ?? '';
  const conflictCommand = useLicenceCommand(conflictId);
  const flight = useSingleFlight();
  const [designation, setDesignation] = useState<'yes' | 'no' | null>(null);
  const [ticks, setTicks] = useState(NO_TICKS);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [reason, setReason] = useState<DeclineReason | ''>('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [revokeReason, setRevokeReason] = useState<RevokeReason | ''>('');
  const review = query.data;

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

  const open = review?.status === 'AWAITING_REVIEW' || review?.status === 'AWAITING_CONFIRMATION';
  const allTicked = CHECKLIST.every(({ key }) => ticks[key]);
  const approval = {
    designation_visible: true as const,
    checklist: { selfie_matches: true, security_features: true, whole_card: true } as const,
  };
  const iApproved =
    review?.approved_by !== null &&
    review?.approved_by !== undefined &&
    review.approved_by === me.data?.user_id;
  const chip = review ? statusChip(review.status) : null;
  const loadError = query.isError ? licenceLoadError(query.error) : null;
  const pending = command.isPending || conflictCommand.isPending;
  const block = review ? approvalBlock(review) : null;

  return (
    <>
      <title>Licence review · SUAS Admin</title>
      <BackLink to={paths.adminLicenceReviews}>Back to licence reviews</BackLink>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="heading text-40 max-sm:text-32">Licence review</h1>
          {review !== undefined ? (
            <p className="text-slate">{sentAgo(review.submitted_at)}</p>
          ) : null}
        </div>
        {review !== undefined && chip !== null ? (
          <div className="flex flex-wrap gap-2">
            <StatusChip kind={chip.kind}>{chip.text}</StatusChip>
            {review.is_dispute ? <StatusChip kind="warn">Dispute</StatusChip> : null}
          </div>
        ) : null}
      </div>

      {review === undefined && query.isPending ? (
        <p role="status" className="text-slate">
          Loading…
        </p>
      ) : review === undefined ? (
        loadError !== null ? (
          <p role="alert" className="font-bold">
            {loadError}
          </p>
        ) : (
          <QueryNotice
            error={query.error}
            what="this review"
            onRetry={() => void query.refetch()}
          />
        )
      ) : !open ? (
        <Card
          as="section"
          aria-label="Decision"
          padding="lg"
          className="flex max-w-2xl flex-col gap-3"
        >
          <DecidedRecord review={review} />
          {review.status === 'APPROVED' && review.viewer.can_revoke ? (
            <div>
              <Button variant="secondary" onClick={() => setDialog('revoke')}>
                Revoke this approval
              </Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <>
          <Card
            as="section"
            aria-labelledby="images-title"
            padding="md"
            className="flex flex-col gap-5"
          >
            <h2 id="images-title" className="text-22 font-bold">
              Images
            </h2>
            <LicenceReviewImages id={id} images={review.images} />
            <RadioCardGroup
              legend="Can you see the Veteran designation on the licence photo?"
              hint="Answer from the images alone. The reading and checks show after you answer."
              name="designation"
              options={[
                { value: 'yes', title: 'Yes, I can see it' },
                { value: 'no', title: 'No', description: 'This declines the review.' },
              ]}
              value={designation ?? ''}
              onValueChange={answerDesignation}
            />
          </Card>

          {designation === 'yes' ? (
            <>
              <Card as="section" aria-label="Reading" padding="lg">
                <LicenceReviewReading review={review} />
              </Card>
              {review.conflicting_review !== null ? (
                <Card as="section" aria-label="Dispute" padding="lg">
                  <ConflictingReview
                    conflict={review.conflicting_review}
                    actions={
                      review.conflicting_review.status === 'APPROVED' ? (
                        <div>
                          <Button variant="secondary" onClick={() => setDialog('revoke_conflict')}>
                            Revoke that approval
                          </Button>
                        </div>
                      ) : null
                    }
                  />
                </Card>
              ) : null}
              <Card
                as="section"
                aria-labelledby="decide-title"
                padding="lg"
                className="flex flex-col gap-5"
              >
                <h2 id="decide-title" className="text-22 font-bold">
                  {review.status === 'AWAITING_CONFIRMATION' ? 'Confirm or decline' : 'Decide'}
                </h2>
                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-2 text-20 font-bold">Check by eye</legend>
                  {CHECKLIST.map(({ key, label }) => (
                    <label key={key} className="flex min-h-11 items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1 size-6 shrink-0 accent-service-blue"
                        checked={ticks[key]}
                        onChange={(event) =>
                          setTicks((current) => ({ ...current, [key]: event.target.checked }))
                        }
                      />
                      {label}
                    </label>
                  ))}
                  <p className="text-16 text-slate">
                    If any of these is not true, decline the review with a reason.
                  </p>
                </fieldset>
                {block !== null ? <p className="font-bold">{block}</p> : null}
                {review.status === 'AWAITING_CONFIRMATION' && iApproved ? (
                  <p className="font-bold">
                    You approved this review, so a different admin must confirm it.
                  </p>
                ) : review.status === 'AWAITING_CONFIRMATION' && review.approved_by !== null ? (
                  <p className="text-slate">
                    First approval by admin {review.approved_by}. Check everything again yourself
                    before you confirm.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  {review.status === 'AWAITING_REVIEW' && review.viewer.can_approve ? (
                    <Button
                      disabled={!allTicked || block !== null}
                      onClick={() => setDialog('approve')}
                    >
                      Approve (first review)
                    </Button>
                  ) : null}
                  {review.status === 'AWAITING_CONFIRMATION' && !iApproved ? (
                    <Button
                      disabled={!allTicked || block !== null}
                      onClick={() => setDialog('confirm')}
                    >
                      Confirm approval
                    </Button>
                  ) : null}
                  {review.viewer.can_decline ? (
                    <Button variant="secondary" onClick={() => setDialog('decline')}>
                      Decline
                    </Button>
                  ) : null}
                  <Button variant="ghost" onClick={() => setDialog('recuse')}>
                    Step back from this review
                  </Button>
                </div>
              </Card>
            </>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={dialog === 'approve'}
        title="Approve this licence?"
        confirmLabel="Approve licence"
        cancelLabel="Cancel"
        pending={pending}
        error={command.isError ? licenceCommandError(command.error) : undefined}
        onConfirm={() => run(() => command.mutateAsync({ name: 'approve', body: approval }))}
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
        onConfirm={() => run(() => command.mutateAsync({ name: 'confirm', body: approval }))}
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
          onChange={(event) => {
            setReason(event.target.value as DeclineReason | '');
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
            void navigate(paths.adminLicenceReviews);
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
                setRevokeReason(value as RevokeReason);
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
