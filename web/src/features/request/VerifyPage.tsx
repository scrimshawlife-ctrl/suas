import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { AlertCircleIcon, LockIcon } from '../../components/icons';
import { useSingleFlight } from '../../lib/single-flight';
import { useConfirmVeteranStatus, useIdVerification, useSelfAttest } from '../public/api';
import { safeFrom } from '../public/signin-flow';
import {
  EMPTY_VERIFY_FORM,
  toConfirmBody,
  validateVerifyForm,
  type VerifyFormErrors,
  type VerifyFormValues,
} from '../public/verify-form';
import {
  FORM_VIEWS,
  isGateError,
  retryAfterText,
  verifyView,
  type VerifyChoice,
  type VerifyOutcome,
} from '../public/verify-status';
import { VerifyForm } from './VerifyForm';
import { HelpOthers, SelfAttestButton, VaNotice, ViewMessage } from './VerifyViews';

/** The send failures that are not about one field. Codes are never shown. */
function sendErrorText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === 'VALIDATION_FAILED') {
      return 'Some details are not in a form VA accepts. Check each one and send again.';
    }
    if (error.code === 'IDEMPOTENCY_CONFLICT') {
      return "We couldn't send your details just now. Wait a moment, then send them again.";
    }
    if (error.code === 'VA_NOTICE_VERSION_REQUIRED') {
      return 'This page is out of date. Reload it, read the notice again, then send.';
    }
  }
  return 'We could not send your details. Check your connection and try again.';
}

/**
 * Verify: the person either sends their details to VA once and sees VA's answer, or tells us
 * they served (D-016 self-attestation). Either one opens the request gate.
 */
export default function VerifyPage() {
  const location = useLocation();
  const continueTo = safeFrom((location.state as { from?: unknown } | null)?.from) ?? paths.request;
  const standing = useIdVerification();
  const confirm = useConfirmVeteranStatus();
  const selfAttest = useSelfAttest();
  const flight = useSingleFlight();

  const [values, setValues] = useState<VerifyFormValues>(EMPTY_VERIFY_FORM);
  const [errors, setErrors] = useState<VerifyFormErrors>({});
  const [attempt, setAttempt] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [choice, setChoice] = useState<VerifyChoice>(null);
  const [attestError, setAttestError] = useState<string | null>(null);
  // Changes with every answer, so the same view shown twice is still announced and focused.
  const [answered, setAnswered] = useState(0);

  const view = verifyView(standing.data, outcome, choice);
  const retryAfter = retryAfterText(
    outcome !== null && 'error' in outcome ? outcome.error.retryAfterSeconds : null,
  );

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
      answer({ result });
    } catch (error) {
      if (isGateError(error)) answer({ error });
      else setSendError(sendErrorText(error));
    } finally {
      // Drops the request body from the mutation cache.
      confirm.reset();
    }
  };

  const answer = (next: VerifyOutcome | null, nextChoice: VerifyChoice = null) => {
    setOutcome(next);
    setChoice(nextChoice);
    setAnswered((count) => count + 1);
  };
  const reopen = () => answer(null, 'form');
  const chooseSelfAttest = () => {
    setAttestError(null);
    setChoice('self_attest');
    setAnswered((count) => count + 1);
  };

  const attest = async () => {
    setAttestError(null);
    try {
      const result = await selfAttest.mutateAsync();
      // The standing is now VERIFIED; drop what was typed for VA.
      setValues(EMPTY_VERIFY_FORM);
      answer({ result });
    } catch (error) {
      if (isApiError(error) && error.code === 'VERIFICATION_REVOKED') answer({ error });
      else if (isApiError(error) && error.code === 'IDEMPOTENCY_CONFLICT') {
        setAttestError("We couldn't save that just now. Wait a moment, then try again.");
      } else setAttestError('We could not save that. Check your connection and try again.');
    }
  };

  return (
    <Page className="gap-7 pt-12 pb-18">
      <title>Confirm you served · SUAS</title>
      <div className="flex max-w-[760px] flex-col gap-2.5">
        <h1 className="heading text-56 max-sm:text-40">Confirm you served</h1>
        <p className="text-20 text-slate">
          Anyone signed in can help. To ask for help, confirm with VA or tell us you served.
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
                    attesting={selfAttest.isPending}
                    attestError={attestError}
                    onReopen={reopen}
                    onChooseSelfAttest={chooseSelfAttest}
                    onAttest={() => flight(attest)}
                    onBack={reopen}
                  />
                </div>
              </div>
              {FORM_VIEWS.has(view) ? (
                <>
                  <VaNotice />
                  <VerifyForm
                    values={values}
                    errors={errors}
                    attempt={attempt}
                    sending={confirm.isPending}
                    sendError={sendError}
                    onChange={change}
                    onSubmit={() => flight(submit)}
                    alternative={<SelfAttestButton onChoose={chooseSelfAttest} />}
                  />
                </>
              ) : null}
              {view === 'verified' || view === 'attested' ? null : <HelpOthers />}
            </div>
          </Card>
        )}

        <aside className="flex flex-col gap-4">
          <Card aria-labelledby="keep" className="flex flex-col gap-3">
            <h2 id="keep" className="flex items-center gap-2.5 text-20 font-bold">
              <LockIcon />
              What SUAS keeps
            </h2>
            <p>
              The result, the reason VA gave, when you checked, which version of the notice you saw,
              and a keyed fingerprint of your details. The fingerprint can't be turned back into
              your details. We don't keep the name, birth date or address you type here.
            </p>
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
