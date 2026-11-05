import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useStartChallenge } from '../../api/auth';
import { useSessionToken } from '../../api/token-store';
import { getMode, setMode } from '../../app/mode-store';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { RadioCardGroup } from '../../components/RadioCardGroup';
import { TextField } from '../../components/TextField';
import {
  afterSignInPath,
  modeToRole,
  parseRole,
  roleToMode,
  safeFrom,
  signInErrorMessage,
  validateEmail,
  type Role,
} from './signin-flow';

const ROLE_OPTIONS = [
  {
    value: 'need',
    title: 'I need support',
    description: 'Ask for food, a ride, temporary shelter, or peer support.',
  },
  {
    value: 'serve',
    title: 'I want to serve',
    description: 'Take requests from fellow veterans. You can switch any time.',
  },
] as const;

/** Sign in (SignIn board): choose a role, ask for an emailed code, go on to /sign-in/code. */
export default function SignInPage() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const token = useSessionToken();
  const start = useStartChallenge();
  const from = safeFrom((location.state as { from?: unknown } | null)?.from);
  const [role, setRole] = useState<Role>(() =>
    parseRole(params.get('role'), modeToRole(getMode())),
  );
  const [email, setEmail] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Already signed in: nothing to do here.
  if (token !== null) return <Navigate to={afterSignInPath(from, getMode())} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = validateEmail(email);
    setFieldError(invalid);
    if (invalid || start.isPending) return;
    const destination = email.trim();
    try {
      await start.mutateAsync(destination);
    } catch {
      return; // shown from `start.error`
    }
    setMode(roleToMode(role));
    await navigate('/sign-in/code', { state: { email: destination, from } });
  };

  const error = fieldError ?? (start.isError ? signInErrorMessage(start.error) : null);

  return (
    <Page className="pt-16 pb-20 max-sm:pt-8">
      <title>Sign in · SUAS</title>
      <div className="grid grid-cols-2 items-start gap-14 max-[860px]:grid-cols-1 max-[860px]:gap-8">
        <div className="flex flex-col gap-7">
          <h1 className="heading text-64 max-sm:text-44">Join the mission</h1>
          <RadioCardGroup
            legend="What brings you here today?"
            name="role"
            options={ROLE_OPTIONS}
            value={role}
            onValueChange={(value) => setRole(parseRole(value, role))}
          />
        </div>

        <Card
          aria-labelledby="sign-in"
          padding="none"
          className="flex flex-col gap-6 p-10 max-sm:p-6"
        >
          <div className="flex flex-col gap-2">
            <h2 id="sign-in" className="heading text-32">
              Sign in to continue
            </h2>
            <p className="text-slate">
              We need an email address to send your sign-in code. There is no password.
            </p>
          </div>
          <form noValidate onSubmit={submit} className="flex flex-col gap-6">
            <div aria-live="polite">
              <TextField
                label="Email address"
                type="email"
                name="destination"
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  setFieldError(null);
                }}
                error={error ?? undefined}
                required
              />
            </div>
            <Button type="submit" size="form" disabled={start.isPending} className="w-full">
              {start.isPending ? 'Sending code' : 'Send sign-in code'}
            </Button>
          </form>
        </Card>
      </div>
    </Page>
  );
}
