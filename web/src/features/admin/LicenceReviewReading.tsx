import type { ReactNode } from 'react';
import { StatusChip } from '../../components/StatusChip';
import type { AdminLicenceReview } from './api';
import {
  checkChip,
  CONSISTENCY_CHECKS,
  designationText,
  fingerprintText,
  identityMatchText,
  LICENCE_FIELDS,
  sourceLabel,
  statusChip,
} from './licence-labels';

const formatDateTime = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function formatWhen(at: string | null | undefined): string {
  return at ? formatDateTime.format(new Date(at)) : 'Not yet';
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-22 font-bold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const CheckThis = () => <StatusChip kind="warn">Check this</StatusChip>;

/**
 * Everything after the designation question (L5.3): the reader's fields with where each came
 * from, the designation on both sides, the consistency checks, identity match and fingerprint.
 * None of these decides the outcome.
 */
export function LicenceReviewReading({ review }: { review: AdminLicenceReview }) {
  const reading = review.reading;
  return (
    <div className="flex flex-col gap-6">
      <Section id="reading-title" title="What the reader read">
        {reading === null ? (
          <p className="text-slate">There is no reading for this review.</p>
        ) : (
          <dl className="flex flex-col gap-4">
            {LICENCE_FIELDS.map(({ key, label }) => {
              const field = reading.fields[key];
              return (
                <div key={key} className="flex flex-col gap-0.5">
                  <dt className="flex flex-wrap items-center gap-2 text-17 font-bold">
                    {label}
                    {field.agreed ? null : <CheckThis />}
                  </dt>
                  <dd className="break-words">{field.value ?? 'Not read'}</dd>
                  <dd className="text-16 text-slate">
                    {sourceLabel(field.source)}
                    {field.agreed ? '' : '. The two reads disagreed'}
                  </dd>
                </div>
              );
            })}
            <div className="flex flex-col gap-0.5">
              <dt className="flex flex-wrap items-center gap-2 text-17 font-bold">
                Veteran designation
                {reading.veteran.agreed ? null : <CheckThis />}
              </dt>
              <dd>On the barcode: {designationText(reading.veteran.barcode)}.</dd>
              <dd>On the front: {designationText(reading.veteran.front)}.</dd>
            </div>
          </dl>
        )}
      </Section>

      <Section id="checks-title" title="Consistency checks: these do not show the card is genuine">
        <p className="text-16 text-slate">
          They only show that parts of the image agree with each other. A well-made fake or an
          edited photo can pass every one.
        </p>
        {reading === null ? null : (
          <ul className="flex flex-col gap-2.5">
            {CONSISTENCY_CHECKS.map(({ key, label }) => {
              const chip = checkChip(reading.consistency_checks[key]);
              return (
                <li key={key} className="flex flex-wrap items-center gap-2">
                  <StatusChip kind={chip.kind}>{chip.text}</StatusChip>
                  <span className="font-bold">{label}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="signals-title" title="Identity and duplicates">
        <dl className="flex flex-col gap-3">
          <div>
            <dt className="text-17 font-bold">Identity match</dt>
            <dd>{identityMatchText(review.identity_match)}.</dd>
          </div>
          <div>
            <dt className="text-17 font-bold">Fingerprint in use</dt>
            <dd>{fingerprintText(review.fingerprint_in_use)}</dd>
          </div>
        </dl>
      </Section>
    </div>
  );
}

/**
 * A dispute's conflicting approved review (L7.3): its record only. Its images were deleted
 * at its decision, so none are shown.
 */
export function ConflictingReview({
  conflict,
  actions,
}: {
  conflict: NonNullable<AdminLicenceReview['conflicting_review']>;
  actions?: ReactNode;
}) {
  const chip = statusChip(conflict.status);
  const rows: [string, ReactNode][] = [
    ['State', <StatusChip kind={chip.kind}>{chip.text}</StatusChip>],
    ['Sent', formatWhen(conflict.submitted_at)],
    ['Decided', formatWhen(conflict.decided_at)],
    ['First approval by (admin id)', conflict.approved_by ?? 'None'],
    ['Confirmed by (admin id)', conflict.confirmed_by ?? 'None'],
    ['Identity match', identityMatchText(conflict.identity_match)],
    ['Notice version', conflict.notice_version],
  ];
  return (
    <Section id="conflict-title" title="The review this licence is already approved on">
      <p className="text-16 text-slate">
        Its images were deleted when it was decided. If that approval was wrong, revoke it first;
        then this review can be approved, which still needs a second admin.
      </p>
      <dl className="flex flex-col gap-3">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-17 font-bold">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>
      {actions}
    </Section>
  );
}
