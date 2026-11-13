import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { CheckIcon } from '../../components/icons';
import { SelfAttestButton } from '../request/VerifyViews';
import {
  declineReasonText,
  LICENCE_APPROVED_TEXT,
  LICENCE_HEADINGS,
  NOT_COUNTED_VIEWS,
  UNREADABLE_TIPS,
  type LicenceView,
} from './licence-status';

// Wording: contributor proposal following VA_CONFIRMATION_FLOW.md §4 conventions (suas-specs #72)
// and SCRY_LICENCE_FALLBACK.md L4 to L6 (#73), for the owner's copy review. Crisis wording comes
// only from the shared crisis components.

const NOT_COUNTED = "This didn't use one of your tries.";

function Heading({ children }: { children: ReactNode }) {
  return (
    <h2 id="check" tabIndex={-1} className="heading text-30">
      {children}
    </h2>
  );
}

export interface LicenceMessageProps {
  view: Exclude<LicenceView, 'not_offered'>;
  /** True when the form is for a dispute of an ALREADY_USED decline (L7.3). */
  disputing: boolean;
  declineReason: string | null;
  /** The server says this decline can be disputed now (DECLINED + ALREADY_USED, reader open). */
  disputable: boolean;
  /** The path is offered, so a new submission may be sent. */
  offered: boolean;
  /** "You can send your licence again after 3:45 PM tomorrow." */
  retryAfter: string;
  continueTo: string;
  onResend: () => void;
  onDispute: () => void;
  onSelfAttest: () => void;
}

/** The heading, words and actions for one licence view; the notice and form sit below `form`. */
export function LicenceMessage(props: LicenceMessageProps) {
  const { view, offered, onResend, onSelfAttest } = props;
  const heading = <Heading>{LICENCE_HEADINGS[view]}</Heading>;
  const notCounted = NOT_COUNTED_VIEWS.has(view) ? <p>{NOT_COUNTED}</p> : null;
  const actions = (resendLabel: string | null) => (
    <div className="flex flex-wrap gap-4">
      {resendLabel !== null && offered ? (
        <Button size="form" onClick={onResend}>
          {resendLabel}
        </Button>
      ) : null}
      <SelfAttestButton onChoose={onSelfAttest} />
    </div>
  );

  switch (view) {
    case 'form':
      return props.disputing ? (
        <div className="flex flex-col gap-3">
          <Heading>Ask us to look again</Heading>
          <p>
            Your earlier photos were deleted when the admin decided, so send new photos of your
            licence and a new selfie. An admin who did not approve the other review will look at
            them.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {heading}
          <p>
            Send photos of the front and back of your licence, and a selfie taken with your camera.
          </p>
        </div>
      );
    case 'reading':
      return (
        <div className="flex flex-col gap-3">
          {heading}
          <p>This usually takes a minute or two. This page checks back every few seconds.</p>
        </div>
      );
    case 'reader_down':
      return (
        <>
          <div className="flex flex-col gap-3">
            {heading}
            <p>Our licence reader is down. Please try again later.</p>
            {notCounted}
          </div>
          {actions('Try again')}
        </>
      );
    case 'unreadable':
      return (
        <>
          <div className="flex flex-col gap-3">
            {heading}
            <p>The reader could not find a licence in those photos. They have been deleted.</p>
            <ul className="flex list-disc flex-col gap-1 pl-6">
              {UNREADABLE_TIPS.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          </div>
          {actions('Send new photos')}
        </>
      );
    case 'photos_lost':
      return (
        <>
          <div className="flex flex-col gap-3">
            {heading}
            <p>Your photos were deleted before an admin could look at them.</p>
            {notCounted}
          </div>
          {actions('Send them again')}
        </>
      );
    case 'not_synthetic':
      return (
        <>
          <div className="flex flex-col gap-3">
            {heading}
            <p>
              This version of SUAS reads sample licences only, so your photos were deleted without
              being read.
            </p>
            {notCounted}
          </div>
          {actions(null)}
        </>
      );
    case 'awaiting':
      return (
        <div className="flex flex-col gap-3">
          {heading}
          <p>
            A SUAS admin will look at your photos, and a second admin confirms any approval. You can
            leave this page. When you come back, it shows the answer.
          </p>
        </div>
      );
    case 'approved':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>
              <span className="flex items-center gap-2.5">
                <CheckIcon size={28} />
                {LICENCE_HEADINGS.approved}
              </span>
            </Heading>
            <p className="text-slate">{LICENCE_APPROVED_TEXT}</p>
          </div>
          <div>
            <Button size="form" href={props.continueTo}>
              Continue
            </Button>
          </div>
        </>
      );
    case 'declined':
      return (
        <>
          <div className="flex flex-col gap-3">
            {heading}
            <p>{declineReasonText(props.declineReason)}</p>
            <p>This is not a finding that you did not serve.</p>
          </div>
          {props.disputable ? (
            <div>
              <Button size="form" onClick={props.onDispute}>
                If this is your licence, ask us to look again
              </Button>
            </div>
          ) : null}
          {actions('Send your licence again')}
        </>
      );
    case 'withdrawn':
      return (
        <>
          <div className="flex flex-col gap-3">
            {heading}
            <p>
              An admin withdrew the approval of your licence, so it no longer confirms your Veteran
              status. You can send your licence again, or tell us you served instead.
            </p>
          </div>
          {actions('Send your licence again')}
        </>
      );
    case 'limit':
      return (
        <>
          <div className="flex flex-col gap-3">
            {heading}
            <p>
              You've sent the most licence reviews allowed in the last 24 hours. {props.retryAfter}{' '}
              You can still tell us you served instead.
            </p>
          </div>
          {actions(null)}
        </>
      );
    case 'closed':
      return (
        <>
          <div className="flex flex-col gap-3">
            {heading}
            <p>We can't take licence photos right now. You can tell us you served instead.</p>
          </div>
          {actions(null)}
        </>
      );
    case 'revoked':
      return (
        <div className="flex flex-col gap-3">
          {heading}
          <p>
            An administrator withdrew your Veteran confirmation, so you can't ask for help right
            now. You can still help others.
          </p>
        </div>
      );
  }
}
