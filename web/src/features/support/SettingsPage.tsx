import { useRef, useState, type FormEvent } from 'react';
import { useMe } from '../../api/me';
import { useUpdateCounty, useUpdateProfile } from '../../api/profile';
import type { Me } from '../../api/types';
import { useMode } from '../../app/mode-store';
import { paths } from '../../app/paths';
import { LoadFailedScreen, LoadingScreen } from '../../app/status-screens';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Dialog } from '../../components/Dialog';
import { AlertCircleIcon } from '../../components/icons';
import { Page } from '../../components/Page';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { ProfileFields } from '../public/ProfileFields';
import {
  COUNTY_OPTIONS,
  isCounty,
  profileSaveError,
  validateWelcome,
  type WelcomeErrors,
} from '../public/welcome-form';

/** "Merced" for MERCED. */
function countyName(value: string): string {
  return COUNTY_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

/**
 * #293 / R12.2 owner question 1, recommended option (OWNER DECISION, draft copy): a county
 * change is said before it is sent. The open list reads the requester's current county
 * (src/coordination/open-requests.ts), so requests nobody has accepted yet move with it.
 */
export function countyChangeText(to: string): string {
  return `Requests you sent that nobody has accepted yet will move to the ${countyName(to)} County list, and the requests you see to help with will be from ${countyName(to)} County.`;
}

/** The form, seeded once from `me`. Only a value that changed is sent. */
function SettingsForm({ me }: { me: Me }) {
  const updateProfile = useUpdateProfile();
  const updateCounty = useUpdateCounty();
  const [displayName, setDisplayName] = useState(me.display_name ?? '');
  const [county, setCounty] = useState<string>(me.county ?? '');
  const [errors, setErrors] = useState<WelcomeErrors>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [confirmingCounty, setConfirmingCounty] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, String(attempt));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setAttempt((count) => count + 1);
    const found = validateWelcome(displayName, county);
    setErrors(found);
    setSaveError(null);
    setSaved(false);
    if (Object.keys(found).length > 0 || saving || !isCounty(county)) return;
    // A new county is sent only after the person has read what it moves.
    if (county !== me.county) {
      setConfirmingCounty(true);
      return;
    }
    void save();
  };

  const save = async () => {
    if (!isCounty(county)) return;
    setConfirmingCounty(false);
    setSaving(true);
    try {
      const name = displayName.trim();
      if (name !== me.display_name) await updateProfile.mutateAsync(name);
      if (county !== me.county) await updateCounty.mutateAsync(county);
      setSaved(true);
    } catch (error) {
      setSaveError(profileSaveError(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card aria-labelledby="profile" padding="none" className="flex flex-col gap-6 p-10 max-sm:p-6">
      <h2 id="profile" className="heading text-32">
        Your profile
      </h2>
      <form ref={formRef} noValidate onSubmit={submit} className="flex flex-col gap-6">
        <ProfileFields
          displayName={displayName}
          county={county}
          errors={errors}
          onDisplayNameChange={(value) => {
            setDisplayName(value);
            setSaved(false);
            setErrors((current) => ({ ...current, displayName: undefined }));
          }}
          onCountyChange={(value) => {
            setCounty(value);
            setSaved(false);
            setErrors((current) => ({ ...current, county: undefined }));
          }}
        />
        <div role="status" aria-live="polite" className="empty:hidden">
          {saveError ? (
            <p className="flex items-center gap-2 text-16 font-bold">
              <AlertCircleIcon size={20} />
              {saveError}
            </p>
          ) : saved ? (
            <p className="font-bold">Saved.</p>
          ) : null}
        </div>
        <div className="flex">
          <Button type="submit" size="form" disabled={saving}>
            {saving ? 'Saving' : 'Save changes'}
          </Button>
        </div>
      </form>
      {confirmingCounty ? (
        <Dialog
          open
          onClose={() => setConfirmingCounty(false)}
          title={`Change your county to ${countyName(county)}?`}
        >
          <p>{countyChangeText(county)}</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void save()}>Change county</Button>
            <Button variant="secondary" onClick={() => setConfirmingCounty(false)}>
              Cancel
            </Button>
          </div>
        </Dialog>
      ) : null}
    </Card>
  );
}

/**
 * /settings: change the display name and county (R12.2, contributor proposal, SUAS-specs #79).
 * It holds nothing else in v1. Reached from the avatar menu in both modes.
 */
export default function SettingsPage() {
  const me = useMe();
  const home = useMode() === 'serve' ? paths.serve : paths.home;
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) return <LoadFailedScreen onRetry={() => void me.refetch()} />;
  return (
    <Page width="narrow">
      <BackLink to={home}>Back to home</BackLink>
      <h1 className="heading text-40 max-sm:text-30">Settings</h1>
      <SettingsForm me={me.data} />
    </Page>
  );
}
