import { useRef, useState, type ClipboardEvent, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useVerifyChallenge } from '../../api/auth';
import { getMode } from '../../app/mode-store';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { fieldClass, FieldShell } from '../../components/FieldShell';
import { Page } from '../../components/Page';
import { ChevronLeftIcon } from '../../components/icons';
import { cn } from '../../lib/cn';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { useSingleFlight } from '../../lib/single-flight';
import {
  afterSignInPath,
  cleanCode,
  safeFrom,
  signInErrorMessage,
  validateCode,
} from './signin-flow';

interface CodeState {
  email?: unknown;
  from?: unknown;
}

/** Six cells drawn behind one input, as on the Code board. */
const cells = {
  background:
    'repeating-linear-gradient(90deg,#fff 0 calc(100%/6 - 2px),#F2F4F7 calc(100%/6 - 2px) calc(100%/6))',
};

/** Enter code (Code board): one 6-digit field, then the session and on to the right home. */
export default function CodePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const verify = useVerifyChallenge();
  const flight = useSingleFlight();
  const state = (location.state ?? {}) as CodeState;
  const email = typeof state.email === 'string' && state.email !== '' ? state.email : null;
  const from = safeFrom(state.from);
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const error = fieldError ?? (verify.isError ? signInErrorMessage(verify.error) : null);
  useFocusFirstInvalid(formRef, `${attempt}|${error ?? ''}`);

  if (email === null) return <Navigate to="/sign-in" replace />;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempt((count) => count + 1);
    const invalid = validateCode(code);
    setFieldError(invalid);
    if (invalid) return;
    flight(async () => {
      try {
        await verify.mutateAsync({ destination: email, code });
      } catch {
        return; // shown from `verify.error`
      }
      await navigate(afterSignInPath(from, getMode()), { replace: true });
    });
  };

  const onPaste = (event: ClipboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    setCode(cleanCode(event.clipboardData.getData('text')));
    setFieldError(null);
  };

  return (
    <Page width="narrow" className="gap-7 pt-18 max-sm:pt-8">
      <title>Enter the code · SUAS</title>
      <Link
        to="/sign-in"
        state={{ from }}
        className="inline-flex min-h-11 items-center gap-1.5 self-start font-bold"
      >
        <ChevronLeftIcon />
        Use a different email
      </Link>
      <div className="flex flex-col gap-3">
        <h1 className="heading text-56 max-sm:text-44">Enter the code</h1>
        <p className="text-20 text-slate">
          If this email is enrolled, a one-time sign-in code was sent to{' '}
          <strong className="text-ink">{email}</strong>.
        </p>
      </div>
      <Card aria-label="Sign-in code" padding="none" className="p-9 max-sm:p-6">
        <form ref={formRef} noValidate onSubmit={submit} className="flex flex-col gap-3.5">
          <div aria-live="polite">
            <FieldShell
              label="6-digit code"
              helper="You can paste the whole code at once."
              error={error ?? undefined}
              id="sign-in-code"
            >
              {(control) => (
                <input
                  {...control}
                  name="code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  required
                  value={code}
                  onChange={(event) => {
                    setCode(cleanCode(event.target.value));
                    setFieldError(null);
                  }}
                  onPaste={onPaste}
                  style={cells}
                  className={cn(
                    fieldClass,
                    'font-display min-h-21 rounded-10 border-ink px-6 text-44 font-bold tracking-[0.42em] tabular-nums max-sm:px-3 max-sm:text-32',
                  )}
                />
              )}
            </FieldShell>
          </div>
          <Button type="submit" size="form" disabled={verify.isPending} className="mt-2.5">
            {verify.isPending ? 'Checking code' : 'Verify and continue'}
          </Button>
        </form>
      </Card>
    </Page>
  );
}
