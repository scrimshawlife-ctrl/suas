import { Select } from '../../components/Select';
import { TextField } from '../../components/TextField';
import { COUNTY_OPTIONS, type WelcomeErrors } from './welcome-form';

export interface ProfileFieldsProps {
  displayName: string;
  county: string;
  errors: WelcomeErrors;
  onDisplayNameChange: (value: string) => void;
  onCountyChange: (value: string) => void;
}

/** Display name and county, as Welcome sets them and Settings changes them (R12.2). */
export function ProfileFields({
  displayName,
  county,
  errors,
  onDisplayNameChange,
  onCountyChange,
}: ProfileFieldsProps) {
  return (
    <>
      <TextField
        label="Name other veterans will see"
        helper="First name and last initial, like Marcus T."
        name="display_name"
        autoComplete="given-name"
        value={displayName}
        onChange={(event) => onDisplayNameChange(event.target.value)}
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
        onChange={(event) => onCountyChange(event.target.value)}
        error={errors.county}
        required
      />
    </>
  );
}
