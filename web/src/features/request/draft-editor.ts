import { useState } from 'react';
import { useUpdateDraft, type DraftEdit, type IntakeDraft } from './api';
import { isCategory, type RequestFields } from './request-fields';

export function fieldsFromDraft(draft: IntakeDraft | null): RequestFields {
  return {
    category: isCategory(draft?.category) ? draft.category : '',
    summary: draft?.summary ?? '',
    timing: draft?.timing ?? '',
    meetingPlace: draft?.meeting_place ?? '',
  };
}

/** The fields that differ from the saved draft, in the shape PATCH takes. Empty means clear. */
export function draftEdit(fields: RequestFields, saved: IntakeDraft): DraftEdit {
  const edit: DraftEdit = {};
  if (fields.category !== '' && fields.category !== saved.category) edit.category = fields.category;
  const summary = fields.summary.trim();
  if (summary !== '' && summary !== saved.summary) edit.summary = summary;
  const timing = fields.timing.trim() || null;
  if (timing !== saved.timing) edit.timing = timing;
  const place = fields.meetingPlace.trim() || null;
  if (place !== saved.meeting_place) edit.meeting_place = place;
  return edit;
}

export interface DraftEditor {
  fields: RequestFields;
  change: (patch: Partial<RequestFields>) => void;
  /** PATCH what changed since the last save; resolves to the saved draft. */
  save: () => Promise<IntakeDraft>;
  saveError: unknown;
}

/**
 * The editable copy of a draft. The server draft is the source of truth: a new `updated_at`
 * (a follow-up reply) replaces the local edits, so edits are saved first with `save()`.
 */
export function useDraftEditor(draft: IntakeDraft | null): DraftEditor {
  const [fields, setFields] = useState(() => fieldsFromDraft(draft));
  const [saved, setSaved] = useState(draft);
  const [syncedAt, setSyncedAt] = useState(draft?.updated_at);
  const update = useUpdateDraft();

  if (draft && draft.updated_at !== syncedAt) {
    setSyncedAt(draft.updated_at);
    setSaved(draft);
    setFields(fieldsFromDraft(draft));
  }

  const save = async (): Promise<IntakeDraft> => {
    if (saved === null) throw new Error('There is no draft to save.');
    const edit = draftEdit(fields, saved);
    if (Object.keys(edit).length === 0) return saved;
    const next = await update.mutateAsync({ draftId: saved.draft_id, edit });
    setSaved(next);
    return next;
  };

  return {
    fields,
    change: (patch) => setFields((current) => ({ ...current, ...patch })),
    save,
    saveError: update.error,
  };
}
