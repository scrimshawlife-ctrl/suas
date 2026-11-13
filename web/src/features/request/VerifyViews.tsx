import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { AlertCircleIcon, CheckIcon } from '../../components/icons';
import type { VerifyView } from '../public/verify-status';

// Wording: VA_CONFIRMATION_FLOW.md §4 (suas-specs #72, contributor proposal); the
// self-attestation step is DECISION_PENDING owner copy, as no released D-016 wording exists.

function Heading({ children }: { children: ReactNode }) {
  return (
    <h2 id="check" tabIndex={-1} className="heading text-30">
      {children}
    </h2>
  );
}

const SELF_ATTEST_INSTEAD = 'You can try different details, or tell us you served instead.';
const NOT_COUNTED = "This didn't use one of your tries.";

/** `va-notice-v1` (VA_CONFIRMATION_FLOW §4.1). Shown above the form every time it opens. */
export function VaNotice() {
  return (
    <section aria-labelledby="va-notice" className="flex flex-col gap-3">
      <h3 id="va-notice" className="text-20 font-bold">
        Before you send anything to VA
      </h3>
      <p>
        To ask for help, you can confirm your Veteran status with the U.S. Department of Veterans
        Affairs (VA), or tell us yourself that you served. Checking with VA is your choice.
      </p>
      <ul className="flex list-disc flex-col gap-2 pl-6">
        <li>
          <strong>What we send:</strong> your first and last name, date of birth, and your current
          address or where you get mail (street, city, state and ZIP). Country is always USA.
          Nothing else.
        </li>
        <li>
          <strong>Where it goes:</strong> these details leave SUAS and go to VA's Veteran
          Confirmation service, once, only to check your Veteran status. This version of SUAS uses
          VA's test service, not a live VA connection.
        </li>
        <li>
          <strong>What VA tells us:</strong> only whether VA confirms your Veteran status. Neither
          VA nor SUAS decides any benefits or eligibility from this. If VA can't confirm you, it is
          not a finding that you didn't serve.
        </li>
        <li>
          <strong>What we keep:</strong> the result, the reason VA gave, when you checked, which
          version of this notice you saw, and a keyed fingerprint of your details. The fingerprint
          can't be turned back into your details; it stops one person's details from confirming more
          than one account. We don't keep the name, birth date or address you type here.
        </li>
        <li>
          <strong>If you'd rather not use VA:</strong> choose "Tell us you served" instead. You can
          still ask for help.
        </li>
        <li>
          <strong>Helping other Veterans needs no check.</strong>
        </li>
      </ul>
    </section>
  );
}

/** Serve and the crisis screen, on every view that is not a confirmation. */
export function HelpOthers() {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-5">
      <h3 className="text-20 font-bold">You can still help others</h3>
      <p className="text-slate">Helping other veterans needs no check.</p>
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="secondary" href={paths.serve}>
          Go to Serve
        </Button>
        <Link to={paths.crisis} className="inline-flex min-h-11 items-center font-bold">
          More crisis options
        </Link>
      </div>
    </div>
  );
}

/** The D-016 choice, offered with the same size as the VA action beside it. */
export function SelfAttestButton({ onChoose }: { onChoose: () => void }) {
  return (
    <Button variant="secondary" size="form" onClick={onChoose}>
      Tell us you served
    </Button>
  );
}

export interface ViewMessageProps {
  view: VerifyView;
  /** The limit view's "You can try VA again after …" sentence. */
  retryAfter: string;
  continueTo: string;
  attesting: boolean;
  attestError: string | null;
  onReopen: () => void;
  onChooseSelfAttest: () => void;
  onAttest: () => void;
  onBack: () => void;
}

/** The heading, words and actions for one view. The notice and form, when shown, sit below. */
export function ViewMessage(props: ViewMessageProps) {
  const { view, retryAfter, continueTo, onReopen, onChooseSelfAttest } = props;
  const actions = (primary?: ReactNode) => (
    <div className="flex flex-wrap gap-4">
      {primary}
      <SelfAttestButton onChoose={onChooseSelfAttest} />
    </div>
  );
  const continueButton = (
    <div>
      <Button size="form" href={continueTo}>
        Continue
      </Button>
    </div>
  );

  switch (view) {
    case 'start':
      return <Heading>Confirm your Veteran status</Heading>;
    case 'not_found':
      return (
        <div className="flex flex-col gap-3">
          <Heading>VA couldn't match your details</Heading>
          <p>VA did not find a record that matches what you entered.</p>
          <ul className="flex list-disc flex-col gap-1 pl-6">
            <li>Check the spelling of your name, street and city.</li>
            <li>Try your name as it appears on your VA records.</li>
            <li>Try an address where you lived before.</li>
            <li>For a name like O'Leary, try it without the apostrophe: OLeary.</li>
          </ul>
          <p>{SELF_ATTEST_INSTEAD}</p>
        </div>
      );
    case 'not_confirmed':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>VA did not confirm your Veteran status</Heading>
            <p>
              VA could not confirm your Veteran status from its records. This is not a finding that
              you never served.
            </p>
            <p>You can ask VA to review your records.</p>
            <p>{SELF_ATTEST_INSTEAD}</p>
          </div>
          {actions(
            <Button size="form" onClick={onReopen}>
              Try different details
            </Button>,
          )}
        </>
      );
    case 'request_invalid':
      return (
        <div className="flex flex-col gap-3">
          <Heading>We couldn't send your details to VA</Heading>
          <p>Check them and try again. {NOT_COUNTED}</p>
        </div>
      );
    case 'unavailable':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>VA can't be reached right now</Heading>
            <p>
              We couldn't get an answer from VA. {NOT_COUNTED} Try again later, or tell us you
              served instead.
            </p>
          </div>
          {actions(
            <Button size="form" onClick={onReopen}>
              Try again
            </Button>,
          )}
        </>
      );
    case 'disabled':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>The VA check is off here</Heading>
            <p>
              Confirming with VA isn't turned on in this version of SUAS. You can tell us you served
              instead.
            </p>
          </div>
          {actions()}
        </>
      );
    case 'limit':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>You've reached the limit for VA checks</Heading>
            <p>
              You've reached the most VA checks allowed in the last 24 hours. {retryAfter} You can
              still tell us you served instead.
            </p>
          </div>
          {actions()}
        </>
      );
    case 'name_mismatch':
      return (
        <div className="flex flex-col gap-3">
          <Heading>Use the name on your account</Heading>
          <p>
            The name you type must match the name on your SUAS account. Check the spelling, or
            update your name in your profile, then try again. {NOT_COUNTED}
          </p>
        </div>
      );
    case 'identity_taken':
      // Never names or hints at another account (contract D4a); this answer uses a try.
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>We can't use these details</Heading>
            <p>
              These details can't be used to verify this account. You can tell us you served
              instead.
            </p>
          </div>
          {actions()}
        </>
      );
    case 'self_attest':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>Tell us you served</Heading>
            <p>
              SUAS help requests are for Veterans of the U.S. armed forces. We won't check this with
              VA.
            </p>
            <p className="font-bold">I am a Veteran of the U.S. armed forces.</p>
          </div>
          <div aria-live="polite" className="empty:hidden">
            {props.attestError ? (
              <p className="flex items-center gap-2 text-16 font-bold">
                <AlertCircleIcon size={20} />
                {props.attestError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <Button size="form" onClick={props.onAttest} disabled={props.attesting}>
              Yes, I served
            </Button>
            <Button variant="ghost" onClick={props.onBack}>
              Go back
            </Button>
          </div>
        </>
      );
    case 'revoked':
      return (
        <div className="flex flex-col gap-3">
          <Heading>Your confirmation was withdrawn</Heading>
          <p>
            An administrator withdrew your Veteran confirmation, so you can't ask for help right
            now. You can still help others.
          </p>
        </div>
      );
    case 'verified':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>
              <span className="flex items-center gap-2.5">
                <CheckIcon size={28} />
                You're confirmed
              </span>
            </Heading>
            <p className="text-slate">
              VA confirmed your Veteran status. You can ask for help now.
            </p>
          </div>
          {continueButton}
        </>
      );
    case 'attested':
      return (
        <>
          <Heading>
            <span className="flex items-center gap-2.5">
              <CheckIcon size={28} />
              Thanks. You can ask for help now.
            </span>
          </Heading>
          {continueButton}
        </>
      );
  }
}
