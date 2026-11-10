import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { AlertCircleIcon, CheckIcon, LockIcon } from '../../components/icons';
import { useSingleFlight } from '../../lib/single-flight';
import { useConfirmVeteranStatus, useIdVerification } from '../public/api';
import { safeFrom } from '../public/signin-flow';
import {
  EMPTY_VERIFY_FORM,
  toConfirmBody,
  validateVerifyForm,
  type VerifyFormErrors,
  type VerifyFormValues,
} from '../public/verify-form';
import {
  isGateError,
  retryAfterText,
  verifyView,
  type VerifyOutcome,
  type VerifyView,
} from '../public/verify-status';
import { VerifyForm } from './VerifyForm';

function Heading({ children }: { children: ReactNode }) {
  return (
    <h2 id="check" tabIndex={-1} className="heading text-30">
      {children}
    </h2>
  );
}

const NOT_A_FINDING = "If VA can't confirm your status, it doesn't mean you didn't serve.";

function HelpOthers({ crisis = false }: { crisis?: boolean }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-5">
      <h3 className="text-20 font-bold">You can still help others</h3>
      <p className="text-slate">Helping other veterans needs no check.</p>
      {crisis ? <p className="text-slate">Crisis support is here for you any time.</p> : null}
      <div className="flex flex-wrap items-center gap-4">
        <Button variant="secondary" href={paths.serve}>
          Go to Serve
        </Button>
        {crisis ? (
          <Link to={paths.crisis} className="inline-flex min-h-11 items-center font-bold">
            More crisis options
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** The heading and words for one view. The form, when shown, sits below this block. */
function ViewMessage({
  view,
  retryAfter,
  continueTo,
  onReopen,
}: {
  view: VerifyView;
  retryAfter: string;
  continueTo: string;
  onReopen: () => void;
}) {
  switch (view) {
    case 'start':
      return (
        <div className="flex flex-col gap-3">
          <Heading>Confirm your Veteran status</Heading>
          <p>
            To ask for help, we confirm your Veteran status with the U.S. Department of Veterans
            Affairs (VA).
          </p>
          <p>
            We send VA your name, date of birth and home address once, only to check your status.
            SUAS keeps the result, not these details.
          </p>
          <p>Helping other veterans needs no check.</p>
          <p className="text-slate">{NOT_A_FINDING}</p>
        </div>
      );
    case 'not_found':
      return (
        <div className="flex flex-col gap-3">
          <Heading>VA couldn't match your details</Heading>
          <p>
            VA did not find a record that matches what you entered. You can correct it and send it
            again.
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-6">
            <li>Check the spelling of your name, street and city.</li>
            <li>Try your name as it appears on your VA records.</li>
            <li>Try an address where you lived before.</li>
            <li>For a name like O'Leary, try it without the apostrophe: OLeary.</li>
          </ul>
          <p className="text-slate">SUAS keeps the result, not these details. {NOT_A_FINDING}</p>
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
          </div>
          <div>
            <Button size="form" onClick={onReopen}>
              Try different details
            </Button>
          </div>
          <HelpOthers crisis />
        </>
      );
    case 'unavailable':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>VA can't be reached right now</Heading>
            <p>
              We could not get an answer from VA. Try again later. Nothing you entered was kept.
            </p>
          </div>
          <div>
            <Button size="form" onClick={onReopen}>
              Try again
            </Button>
          </div>
          <HelpOthers />
        </>
      );
    case 'limit':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>You've reached today's limit of tries</Heading>
            <p>{retryAfter}</p>
          </div>
          <HelpOthers />
        </>
      );
    case 'revoked':
      return (
        <>
          <div className="flex flex-col gap-3">
            <Heading>Your confirmation was withdrawn</Heading>
            <p>Your Veteran confirmation is no longer in place, so you can't ask for help here.</p>
          </div>
          <HelpOthers crisis />
        </>
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
          <div>
            <Button size="form" href={continueTo}>
              Continue
            </Button>
          </div>
        </>
      );
  }
}

/** Verify: the person sends their details to VA once; the page shows VA's answer. */
export default function VerifyPage() {
  const location = useLocation();
  const continueTo = safeFrom((location.state as { from?: unknown } | null)?.from) ?? paths.request;
  const standing = useIdVerification();
  const confirm = useConfirmVeteranStatus();
  const flight = useSingleFlight();

  const [values, setValues] = useState<VerifyFormValues>(EMPTY_VERIFY_FORM);
  const [errors, setErrors] = useState<VerifyFormErrors>({});
  const [attempt, setAttempt] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [reopened, setReopened] = useState(false);
  // Changes with every answer, so the same view shown twice is still announced and focused.
  const [answered, setAnswered] = useState(0);

  const view = verifyView(standing.data, outcome, reopened);
  const retryAfter =
    outcome !== null && 'error' in outcome
      ? retryAfterText(outcome.error.retryAfterSeconds)
      : 'Try again later.';

  // The pressed button often leaves with the old view; keep focus in the card, on its heading.
  const card = useRef<HTMLDivElement>(null);
  const shown = useRef(`${view}|${answered}`);
  useEffect(() => {
    const signal = `${view}|${answered}`;
    if (shown.current === signal) return;
    shown.current = signal;
    const active = document.activeElement;
    if (active === null || active === document.body || card.current?.contains(active)) {
      card.current?.querySelector<HTMLElement>('#check')?.focus();
    }
  }, [view, answered]);

  const change = (field: keyof VerifyFormValues, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    const key = field.startsWith('birth') ? 'birthDate' : field;
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const submit = async () => {
    setAttempt((count) => count + 1);
    setSendError(null);
    const found = validateVerifyForm(values);
    setErrors(found);
    if (Object.keys(found).length > 0 || confirm.isPending) return;
    try {
      const result = await confirm.mutateAsync(toConfirmBody(values));
      if (result.status === 'VERIFIED') setValues(EMPTY_VERIFY_FORM);
      setOutcome({ result });
      setAnswered((count) => count + 1);
    } catch (error) {
      if (isGateError(error)) {
        setOutcome({ error });
        setAnswered((count) => count + 1);
      } else if (isApiError(error) && error.code === 'VALIDATION_FAILED') {
        setSendError('Some details are not in a form VA accepts. Check each one and send again.');
      } else {
        setSendError('We could not send your details. Check your connection and try again.');
      }
    } finally {
      // Drops the request body from the mutation cache.
      confirm.reset();
    }
  };

  const reopen = () => {
    setOutcome(null);
    setReopened(true);
    setAnswered((count) => count + 1);
  };

  return (
    <Page className="gap-7 pt-12 pb-18">
      <title>Confirm you served · SUAS</title>
      <div className="flex max-w-[760px] flex-col gap-2.5">
        <h1 className="heading text-56 max-sm:text-40">Confirm you served</h1>
        <p className="text-20 text-slate">
          Anyone signed in can help. Asking for help needs a quick check with VA.
        </p>
      </div>

      <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] items-start gap-6 max-[860px]:grid-cols-1">
        {standing.isPending ? (
          <Card padding="lg">
            <p role="status" className="text-slate">
              Loading…
            </p>
          </Card>
        ) : standing.isError && standing.data === undefined ? (
          <Card padding="lg" className="flex flex-col gap-4">
            <p className="flex items-start gap-2.5 font-bold">
              <AlertCircleIcon className="mt-0.5" />
              We could not load your check status.
            </p>
            <div>
              <Button variant="secondary" onClick={() => void standing.refetch()}>
                Try again
              </Button>
            </div>
          </Card>
        ) : (
          <Card padding="lg" aria-labelledby="check">
            <div ref={card} className="flex flex-col gap-6">
              {/* The region stays mounted; its content is replaced per answer, so it is announced. */}
              <div aria-live="polite">
                <div key={answered} className="flex flex-col gap-5">
                  <ViewMessage
                    view={view}
                    retryAfter={retryAfter}
                    continueTo={continueTo}
                    onReopen={reopen}
                  />
                </div>
              </div>
              {view === 'start' || view === 'not_found' ? (
                <VerifyForm
                  values={values}
                  errors={errors}
                  attempt={attempt}
                  sending={confirm.isPending}
                  sendError={sendError}
                  onChange={change}
                  onSubmit={() => flight(submit)}
                />
              ) : null}
            </div>
          </Card>
        )}

        <aside className="flex flex-col gap-4">
          <Card aria-labelledby="keep" className="flex flex-col gap-3">
            <h2 id="keep" className="flex items-center gap-2.5 text-20 font-bold">
              <LockIcon />
              What we keep
            </h2>
            <p>Only the result: confirmed or not, when, and that VA checked it.</p>
            <p>Your name, date of birth and address go to VA for the check and are not kept.</p>
          </Card>
          <Card
            aria-labelledby="now"
            className="flex flex-col gap-3 border-ink bg-harbor text-white"
          >
            <h2 id="now" className="text-20 font-bold">
              Immediate danger?{' '}
              <a
                href="tel:911"
                aria-label="Call 911"
                className="inline-flex min-h-11 min-w-11 items-center px-1 text-white"
              >
                Call 911
              </a>
              .
            </h2>
            <p>
              For suicide or emotional crisis support,{' '}
              <a
                href="tel:988"
                aria-label="Call 988"
                className="inline-flex min-h-11 min-w-11 items-center px-1 font-bold text-white"
              >
                call
              </a>{' '}
              or{' '}
              <a
                href="sms:988"
                aria-label="Text 988"
                className="inline-flex min-h-11 min-w-11 items-center px-1 font-bold text-white"
              >
                text 988
              </a>
              .
            </p>
            <p className="font-bold">
              Veterans Crisis Line:{' '}
              <a
                href="sms:838255"
                aria-label="Veterans Crisis Line: Text 838255"
                className="inline-flex min-h-11 min-w-11 items-center px-1 font-bold text-white"
              >
                Text 838255
              </a>
              .
            </p>
            <p className="text-harbor-tint">
              SUAS provides practical support coordination and is not an emergency-response service.
            </p>
          </Card>
        </aside>
      </div>
    </Page>
  );
}
