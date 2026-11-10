import { useRef, useState, type FormEvent } from 'react';
import { isApiError } from '../../api/errors';
import { Button } from '../../components/Button';
import { AlertCircleIcon } from '../../components/icons';
import { Select } from '../../components/Select';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { TextArea } from '../../components/TextArea';
import { TextField } from '../../components/TextField';
import { useDiscardDraft, useEditDraft, usePublishDraft } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { ContactListField } from './ContactListField';
import {
  buildEditPayload,
  draftToForm,
  LIMITS,
  validateDraftForm,
  type DraftFormErrors,
  type DraftFormValues,
  type ResourceDraft,
} from './draft-form';
import { CATEGORIES, CATEGORY_LABELS, COUNTIES, COUNTY_LABELS } from './labels';
import type { ServiceCategory } from '../../api/types';

export const PUBLISH_CONFIRM_TEXT =
  'Publishing makes this a verified Resource that veterans can see.';

/** Plain words for a failed draft command. */
export function draftErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    if (error.status === 409)
      return 'This draft was already published or discarded. The page now shows its current state.';
    if (error.status === 404) return 'We could not find this draft.';
    if (error.status < 500) return error.message;
  }
  return 'That did not go through. Check your connection and try again.';
}

const options = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  values.map((value) => ({ value, label: labels[value] }));

/**
 * Every field of a pending draft, editable, with Save, Publish and Discard. Publishing is
 * the verification act, so it and Discard sit behind a confirm step. Publish and Discard
 * act on the saved draft, so they wait while there are unsaved changes.
 */
export function DraftEditor({
  draft,
  onSaved,
  onEdit,
}: {
  draft: ResourceDraft;
  onSaved: () => void;
  /** Called when the person changes a field, so a stale "Changes saved." can go. */
  onEdit: () => void;
}) {
  const id = draft.resource_draft_id;
  const edit = useEditDraft(id);
  const publish = usePublishDraft(id);
  const discard = useDiscardDraft(id);
  const [values, setValues] = useState<DraftFormValues>(() => draftToForm(draft));
  const [errors, setErrors] = useState<DraftFormErrors>({});
  const [confirm, setConfirm] = useState<'publish' | 'discard' | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [sentContacts, setSentContacts] = useState(false);
  useFocusFirstInvalid(formRef, `${attempt}|${Object.keys(errors).join()}`);

  const payload = buildEditPayload(draft, values);
  const dirty = payload !== null;
  // A 400 on a save that carried the list is a contact refusal (for example a crisis number).
  const serverContactError =
    sentContacts && edit.isError && isApiError(edit.error) && edit.error.status === 400
      ? edit.error.message
      : undefined;
  const set = <K extends keyof DraftFormValues>(field: K, value: DraftFormValues[K]) => {
    onEdit();
    setValues((current) => ({ ...current, [field]: value }));
  };

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (edit.isPending || payload === null) return;
    const found = validateDraftForm(values);
    setErrors(found);
    setAttempt((count) => count + 1);
    if (Object.keys(found).length > 0) return;
    setSentContacts(payload.contacts !== undefined);
    edit.mutate(payload, { onSuccess: onSaved });
  }

  const toggleCounty = (county: (typeof COUNTIES)[number]) =>
    set(
      'counties',
      values.counties.includes(county)
        ? values.counties.filter((c) => c !== county)
        : [...values.counties, county],
    );

  const closeConfirm = () => {
    setConfirm(null);
    publish.reset();
    discard.reset();
  };

  return (
    <>
      <form ref={formRef} onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <TextField
          label="Service name"
          value={values.service_name}
          onChange={(event) => set('service_name', event.target.value)}
          error={errors.service_name}
          maxLength={LIMITS.serviceName}
        />
        <Select
          label="Category"
          value={values.category}
          onChange={(event) => set('category', event.target.value as ServiceCategory | '')}
          error={errors.category}
          placeholder="Choose a category"
          options={options(CATEGORIES, CATEGORY_LABELS)}
        />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-17 font-bold">Counties served</legend>
          <div className="grid grid-cols-2 gap-x-4 max-sm:grid-cols-1">
            {COUNTIES.map((county) => (
              <label
                key={county}
                className="flex min-h-11 cursor-pointer items-center gap-3 text-18"
              >
                <input
                  type="checkbox"
                  className="size-6 shrink-0 accent-service-blue"
                  checked={values.counties.includes(county)}
                  onChange={() => toggleCounty(county)}
                />
                {COUNTY_LABELS[county]}
              </label>
            ))}
          </div>
          <p className="text-16 text-slate">
            Leave all unchecked only if the source states no county limit.
          </p>
        </fieldset>
        <TextArea
          label="Eligibility"
          rows={3}
          value={values.eligibility}
          onChange={(event) => set('eligibility', event.target.value)}
          error={errors.eligibility}
          helper="Exactly as the source states it. Leave empty if it does not."
        />
        <TextField
          label="Hours"
          value={values.hours}
          onChange={(event) => set('hours', event.target.value)}
          error={errors.hours}
        />
        <ContactListField
          rows={values.contacts}
          onChange={(rows) => set('contacts', rows)}
          error={errors.contacts ?? serverContactError}
        />
        <TextField
          label="Area"
          value={values.area}
          onChange={(event) => set('area', event.target.value)}
          error={errors.area}
          maxLength={LIMITS.area}
          helper="A short line such as a city or neighborhood, as the source states it."
        />
        <TextArea
          label="Referral method"
          rows={2}
          value={values.referral_method}
          onChange={(event) => set('referral_method', event.target.value)}
          error={errors.referral_method}
        />
        <TextField
          label="Cost"
          value={values.cost}
          onChange={(event) => set('cost', event.target.value)}
          error={errors.cost}
        />

        {edit.isError && serverContactError === undefined ? (
          <p role="alert" className="flex items-start gap-2 font-bold">
            <AlertCircleIcon className="mt-1 shrink-0" />
            {draftErrorMessage(edit.error)}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" size="form" disabled={!dirty || edit.isPending}>
            {edit.isPending ? 'Saving…' : 'Save changes'}
          </Button>
          <Button
            size="form"
            variant="secondary"
            disabled={dirty || edit.isPending}
            onClick={() => setConfirm('publish')}
          >
            Publish
          </Button>
          <Button
            size="form"
            variant="secondary"
            disabled={dirty || edit.isPending}
            onClick={() => setConfirm('discard')}
          >
            Discard
          </Button>
        </div>
        {dirty ? (
          <p className="text-16 text-slate">Save your changes before you publish or discard.</p>
        ) : null}
      </form>

      <ConfirmDialog
        open={confirm === 'publish'}
        title="Publish this resource?"
        confirmLabel="Publish resource"
        cancelLabel="Cancel"
        pending={publish.isPending}
        error={publish.isError ? draftErrorMessage(publish.error) : undefined}
        onConfirm={() => publish.mutate(undefined)}
        onClose={closeConfirm}
      >
        <p>{PUBLISH_CONFIRM_TEXT}</p>
        <p className="text-16 text-slate">
          Publish only after you have checked the details against the source link.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'discard'}
        title="Discard this draft?"
        confirmLabel="Discard draft"
        cancelLabel="Keep draft"
        pending={discard.isPending}
        error={discard.isError ? draftErrorMessage(discard.error) : undefined}
        onConfirm={() => discard.mutate(undefined)}
        onClose={closeConfirm}
      >
        <p>This draft will not be published. You can still read it under Discarded.</p>
      </ConfirmDialog>
    </>
  );
}
