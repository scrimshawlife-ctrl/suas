import { useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useMe } from '../../api/me';
import { useUpdateCounty, useUpdateProfile } from '../../api/profile';
import type { Me } from '../../api/types';
import { getMode } from '../../app/mode-store';
import { LoadFailedScreen, LoadingScreen } from '../../app/status-screens';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { Select } from '../../components/Select';
import { TextField } from '../../components/TextField';
import { AlertCircleIcon } from '../../components/icons';
import { isApiError } from '../../api/errors';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { afterSignInPath, safeFrom } from './signin-flow';
import { COUNTY_OPTIONS, isCounty, validateWelcome, type WelcomeErrors } from './welcome-form';

function WelcomeForm({ me }: { me: Me }) {
  const navigate = useNavigate();
  const location = useLocation();
  const from = safeFrom((location.state as { from?: unknown } | null)?.from);
  const updateProfile = useUpdateProfile();
  const updateCounty = useUpdateCounty();
  const [displayName, setDisplayName] = useState(me.display_name ?? '');
  const [county, setCounty] = useState<string>(me.county ?? '');
  const [errors, setErrors] = useState<WelcomeErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  // Errors and the attempt count are set in one batch, so the attempt alone is the signal.
  useFocusFirstInvalid(formRef, String(attempt));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setAttempt((count) => count + 1);
    const found = validateWelcome(displayName, county);
    setErrors(found);
    setSaveError(null);
    if (Object.keys(found).length > 0 || saving || !isCounty(county)) return;
    setSaving(true);
    try {
      await updateProfile.mutateAsync(displayName.trim());
      await updateCounty.mutateAsync(county);
    } catch (error) {
      setSaveError(
        isApiError(error) && error.status < 500
          ? error.message
          : 'We could not save that. Check your connection and try again.',
      );
      setSaving(false);
      return;
    }
    await navigate(afterSignInPath(from, getMode()), { replace: true });
  };

  return (
    <Page className="pt-16 pb-20 max-sm:pt-8">
      <title>Welcome · SUAS</title>
      <div className="grid grid-cols-2 items-start gap-14 max-[860px]:grid-cols-1 max-[860px]:gap-8">
        <div className="flex flex-col gap-4">
          <h1 className="heading text-64 max-sm:text-44">Welcome to SUAS</h1>
          <p className="max-w-[34ch] text-20 text-slate">
            Two quick details, then you are in. You can change them later.
          </p>
        </div>
        <Card
          aria-labelledby="profile"
          padding="none"
          className="flex flex-col gap-6 p-10 max-sm:p-6"
        >
          <h2 id="profile" className="heading text-32">
            Set up your profile
          </h2>
          <form ref={formRef} noValidate onSubmit={submit} className="flex flex-col gap-6">
            <TextField
              label="Name other veterans will see"
              helper="First name and last initial, like Marcus T."
              name="display_name"
              autoComplete="given-name"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
                setErrors((current) => ({ ...current, displayName: undefined }));
              }}
              error={errors.displayName}
              required
            />
            <Select
              label="County"
              helper="We match requests with people in the same county."
              name="county"
              placeholder="Choose your county"
              options={COUNTY_OPTIONS}
              value={county}
              onChange={(event) => {
                setCounty(event.target.value);
                setErrors((current) => ({ ...current, county: undefined }));
              }}
              error={errors.county}
              required
            />
            <div aria-live="polite" className="empty:hidden">
              {saveError ? (
                <p className="flex items-center gap-2 text-16 font-bold">
                  <AlertCircleIcon size={20} />
                  {saveError}
                </p>
              ) : null}
            </div>
            <Button type="submit" size="form" disabled={saving} className="w-full">
              {saving ? 'Saving' : 'Save and continue'}
            </Button>
          </form>
        </Card>
      </div>
    </Page>
  );
}

/** Profile setup (no board; SignIn layout): display name and county, then on to the mode home. */
export default function WelcomePage() {
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) return <LoadFailedScreen onRetry={() => void me.refetch()} />;
  return <WelcomeForm me={me.data} />;
}
