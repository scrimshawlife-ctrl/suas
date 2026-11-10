import { useRef, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { fieldClass } from '../../components/FieldShell';
import { Select } from '../../components/Select';
import { TextField } from '../../components/TextField';
import { AlertCircleIcon } from '../../components/icons';
import { cn } from '../../lib/cn';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import {
  US_STATE_OPTIONS,
  VERIFY_FIELDS,
  type VerifyFormErrors,
  type VerifyFormValues,
} from '../public/verify-form';

export interface VerifyFormProps {
  values: VerifyFormValues;
  errors: VerifyFormErrors;
  /** Bumped on every submit, so focus moves to the first invalid field each time. */
  attempt: number;
  sending: boolean;
  /** A send failure that is not about one field (connection, server). */
  sendError: string | null;
  onChange: (field: keyof VerifyFormValues, value: string) => void;
  onSubmit: () => void;
}

/** Links each error to its field; focus moves to the field itself, not the summary. */
function ErrorSummary({ errors }: { errors: VerifyFormErrors }) {
  const listed = VERIFY_FIELDS.filter(({ field }) => errors[field] !== undefined);
  if (listed.length === 0) return null;
  return (
    <section
      aria-labelledby="verify-errors"
      className="flex flex-col gap-2 rounded-8 border-[3px] border-ink p-5"
    >
      <h3 id="verify-errors" className="flex items-center gap-2 text-20 font-bold">
        <AlertCircleIcon />
        Check these details
      </h3>
      <ul className="flex flex-col gap-1">
        {listed.map(({ field, label, controlId }) => (
          <li key={field}>
            <a
              href={`#${controlId}`}
              className="font-bold"
              onClick={(event) => {
                event.preventDefault();
                document.getElementById(controlId)?.focus();
              }}
            >
              {label}: {errors[field]}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Month, day and year boxes in one fieldset (the memorable-date pattern), sent as YYYY-MM-DD. */
function BirthDateField({
  values,
  error,
  onChange,
}: {
  values: VerifyFormValues;
  error: string | undefined;
  onChange: VerifyFormProps['onChange'];
}) {
  const describedBy = ['va-birth-hint', error ? 'va-birth-error' : null].filter(Boolean).join(' ');
  const parts = [
    { key: 'birthMonth', id: 'va-birth-month', label: 'Month', auto: 'bday-month', size: 2 },
    { key: 'birthDay', id: 'va-birth-day', label: 'Day', auto: 'bday-day', size: 2 },
    { key: 'birthYear', id: 'va-birth-year', label: 'Year', auto: 'bday-year', size: 4 },
  ] as const;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-17 font-bold">Date of birth</legend>
      <p id="va-birth-hint" className="text-16 text-slate">
        For example: 4 28 1986
      </p>
      <div className="flex gap-4">
        {parts.map((part) => (
          <div key={part.key} className="flex flex-col gap-1">
            <label htmlFor={part.id} className="text-16">
              {part.label}
            </label>
            <input
              id={part.id}
              name={part.auto}
              autoComplete={part.auto}
              inputMode="numeric"
              maxLength={part.size}
              value={values[part.key]}
              onChange={(event) => onChange(part.key, event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={error ? true : undefined}
              className={cn(fieldClass, part.size === 4 ? 'w-28' : 'w-20')}
            />
          </div>
        ))}
      </div>
      {error ? (
        <p id="va-birth-error" className="flex items-center gap-2 text-16 font-bold">
          <AlertCircleIcon size={20} />
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** The VA confirmation details: the eight required VA fields, with country fixed to USA. */
export function VerifyForm({
  values,
  errors,
  attempt,
  sending,
  sendError,
  onChange,
  onSubmit,
}: VerifyFormProps) {
  const formRef = useRef<HTMLFormElement>(null);
  useFocusFirstInvalid(formRef, String(attempt));
  const text = (field: keyof VerifyFormValues) => ({
    value: values[field],
    onChange: (event: { target: { value: string } }) => onChange(field, event.target.value),
  });

  return (
    <form
      ref={formRef}
      noValidate
      aria-label="Your details for VA"
      className="flex flex-col gap-6"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <ErrorSummary errors={errors} />
      <div className="grid grid-cols-2 gap-6 max-sm:grid-cols-1">
        <TextField
          id="va-first-name"
          label="First name"
          name="given-name"
          autoComplete="given-name"
          spellCheck={false}
          error={errors.firstName}
          {...text('firstName')}
        />
        <TextField
          id="va-last-name"
          label="Last name"
          name="family-name"
          autoComplete="family-name"
          spellCheck={false}
          error={errors.lastName}
          {...text('lastName')}
        />
      </div>
      <BirthDateField values={values} error={errors.birthDate} onChange={onChange} />
      <TextField
        id="va-street"
        label="Street address"
        helper="Your home address, like 123 Main St Apt 4."
        name="address-line1"
        autoComplete="address-line1"
        error={errors.street}
        {...text('street')}
      />
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)] gap-6 max-sm:grid-cols-1">
        <TextField
          id="va-city"
          label="City"
          name="address-level2"
          autoComplete="address-level2"
          error={errors.city}
          {...text('city')}
        />
        <Select
          id="va-state"
          label="State"
          name="address-level1"
          autoComplete="address-level1"
          placeholder="Choose"
          options={US_STATE_OPTIONS}
          error={errors.state}
          {...text('state')}
        />
        <TextField
          id="va-zip"
          label="ZIP code"
          name="postal-code"
          autoComplete="postal-code"
          error={errors.zip}
          {...text('zip')}
        />
      </div>
      <div aria-live="polite" className="empty:hidden">
        {sendError ? (
          <p className="flex items-center gap-2 text-16 font-bold">
            <AlertCircleIcon size={20} />
            {sendError}
          </p>
        ) : null}
      </div>
      <div>
        <Button type="submit" size="form" disabled={sending}>
          {sending ? 'Sending to VA' : 'Send to VA'}
        </Button>
      </div>
    </form>
  );
}
