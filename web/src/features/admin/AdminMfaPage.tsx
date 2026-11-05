import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { tokenStore } from '../../api/token-store';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { AlertCircleIcon } from '../../components/icons';
import { TextField } from '../../components/TextField';
import { useStartMfaChallenge, useVerifyMfaChallenge } from './api';
import { mfaErrorMessage, mfaIsUnavailable, mfaReturnPath, testFactorHint } from './mfa';

interface Challenge {
  challenge_id: string;
  factor_type: string;
}

/**
 * MFA step-up. Two steps: start a check (the server gives a check id and a factor type),
 * then send the person's response. The only factor today is a test factor, which the
 * server refuses in production; the page says so and never fills the response in.
 */
export default function AdminMfaPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const start = useStartMfaChallenge();
  const verify = useVerifyMfaChallenge();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [response, setResponse] = useState('');
  const [fieldError, setFieldError] = useState<string>();

  const error = start.error ?? verify.error;
  const unavailable = error !== null && mfaIsUnavailable(error);
  const busy = start.isPending || verify.isPending;

  function onStart() {
    verify.reset();
    setResponse('');
    setFieldError(undefined);
    start.mutate(undefined, { onSuccess: (data) => setChallenge(data) });
  }

  function onConfirm(event: FormEvent) {
    event.preventDefault();
    if (challenge === null || busy) return;
    if (response.trim() === '') {
      setFieldError('Enter your response.');
      return;
    }
    setFieldError(undefined);
    verify.mutate(
      { challenge_id: challenge.challenge_id, response: response.trim() },
      {
        onSuccess: () => {
          tokenStore.setMfaElevated(true);
          void navigate(mfaReturnPath(location.state), { replace: true });
        },
        // A check works once, so a failed response needs a new check.
        onError: () => setChallenge(null),
      },
    );
  }

  return (
    <>
      <title>Confirm it is you · SUAS</title>
      <Card
        as="section"
        aria-labelledby="mfa-title"
        padding="lg"
        className="flex max-w-xl flex-col gap-5"
      >
        <h1 id="mfa-title" className="heading text-40 max-sm:text-32">
          Confirm it is you
        </h1>
        <p className="text-slate">
          Admin pages ask for a second check. Start the check, then enter your response.
        </p>

        {unavailable ? (
          <p role="alert" className="flex items-start gap-2 font-bold">
            <AlertCircleIcon className="mt-1 shrink-0" />
            {mfaErrorMessage(error)}
          </p>
        ) : challenge === null ? (
          <>
            {error !== null ? (
              <p role="alert" className="flex items-start gap-2 font-bold">
                <AlertCircleIcon className="mt-1 shrink-0" />
                {mfaErrorMessage(error)}
              </p>
            ) : null}
            <div className="flex">
              <Button onClick={onStart} disabled={busy} size="form">
                {error !== null ? 'Start a new check' : 'Start check'}
              </Button>
            </div>
          </>
        ) : (
          <form onSubmit={onConfirm} noValidate className="flex flex-col gap-4">
            {challenge.factor_type === 'TEST_FACTOR' ? (
              <p className="rounded-8 border border-line bg-mist px-4 py-3">
                This environment uses a test check. It is not a real second factor.
              </p>
            ) : null}
            {import.meta.env.DEV && challenge.factor_type === 'TEST_FACTOR' ? (
              <p className="text-16 text-slate">{testFactorHint(challenge.challenge_id)}</p>
            ) : null}
            <TextField
              label="Your response"
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              error={fieldError}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              autoFocus
            />
            <div className="flex">
              <Button type="submit" size="form" disabled={busy}>
                Confirm
              </Button>
            </div>
          </form>
        )}
      </Card>
    </>
  );
}
