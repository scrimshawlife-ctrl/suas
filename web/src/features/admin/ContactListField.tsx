import { Button } from '../../components/Button';
import { AlertCircleIcon } from '../../components/icons';
import { Select } from '../../components/Select';
import { TextField } from '../../components/TextField';
import { LIMITS, type ContactRow } from './draft-form';
import { CONTACT_KINDS, CONTACT_KIND_LABELS, type ContactKind } from './labels';

const KIND_OPTIONS = CONTACT_KINDS.map((value) => ({ value, label: CONTACT_KIND_LABELS[value] }));

/**
 * Up to three contact rows (kind and value), each removable. `error` is the form or server
 * message for the list; rows with no value or too long a value are marked invalid.
 */
export function ContactListField({
  rows,
  onChange,
  error,
}: {
  rows: ContactRow[];
  onChange: (rows: ContactRow[]) => void;
  error?: string | undefined;
}) {
  const update = (index: number, change: Partial<ContactRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const invalid = (row: ContactRow) =>
    error !== undefined && (row.value.trim() === '' || row.value.trim().length > LIMITS.contact);

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-17 font-bold">Contact methods</legend>
      {rows.length === 0 ? <p className="text-slate">No contact method recorded.</p> : null}
      {rows.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] items-end gap-3 max-sm:grid-cols-1"
        >
          <Select
            label={`Contact ${index + 1} kind`}
            value={row.kind}
            onChange={(event) => update(index, { kind: event.target.value as ContactKind })}
            options={KIND_OPTIONS}
          />
          <TextField
            label={`Contact ${index + 1}`}
            value={row.value}
            maxLength={LIMITS.contact}
            aria-invalid={invalid(row) || undefined}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <Button
            size="form"
            variant="secondary"
            aria-label={`Remove contact ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="flex">
        <Button
          size="small"
          variant="secondary"
          disabled={rows.length >= LIMITS.contacts}
          onClick={() => onChange([...rows, { kind: 'PHONE', value: '' }])}
        >
          Add a contact method
        </Button>
      </div>
      <p className="text-16 text-slate">
        Up to {LIMITS.contacts}, most useful first. Crisis numbers are refused.
      </p>
      {error ? (
        <p role="alert" className="flex items-center gap-2 text-16 font-bold">
          <AlertCircleIcon size={20} />
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
