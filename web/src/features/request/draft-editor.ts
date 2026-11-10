import { useEffect, useRef, useState } from 'react';
import { useUpdateDraft, type DraftEdit, type IntakeDraft } from './api';
import { destinationAllowed, isCategory, mergeFields, type RequestFields } from './request-fields';

export function fieldsFromDraft(draft: IntakeDraft | null): RequestFields {
  return {
    category: isCategory(draft?.category) ? draft.category : '',
    summary: draft?.summary ?? '',
    timing: draft?.timing ?? '',
    meetingPlace: draft?.meeting_place ?? '',
    destination: draft?.destination ?? '',
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
  const destination = (destinationAllowed(fields.category) && fields.destination.trim()) || null;
  if (destination !== (saved.destination ?? null)) edit.destination = destination;
  return edit;
}

export interface DraftEditor {
  fields: RequestFields;
  change: (patch: Partial<RequestFields>) => void;
  /**
   * PATCH what changed since the last save; resolves to the saved draft and rejects when the
   * PATCH fails. Saves run one at a time, in call order, so two PATCHes never overlap.
   */
  save: () => Promise<IntakeDraft>;
  saveError: unknown;
}

/**
 * The editable copy of a draft. The server draft is the source of truth: a new `updated_at`
 * (a follow-up reply) replaces the local edits, so edits are saved first with `save()`.
 */
export function useDraftEditor(draft: IntakeDraft | null): DraftEditor {
  const [fields, setFields] = useState(() => fieldsFromDraft(draft));
  const [syncedAt, setSyncedAt] = useState(draft?.updated_at);
  // The last draft the server confirmed. A ref, because a queued save must read the result
  // of the save before it, not the render it was called in.
  const savedRef = useRef<IntakeDraft | null>(draft);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const update = useUpdateDraft();

  if (draft && draft.updated_at !== syncedAt) {
    setSyncedAt(draft.updated_at);
    setFields(fieldsFromDraft(draft));
  }
  useEffect(() => {
    if (draft) savedRef.current = draft;
  }, [draft]);

  const save = (): Promise<IntakeDraft> => {
    const snapshot = fields;
    const run = async (): Promise<IntakeDraft> => {
      const saved = savedRef.current;
      if (saved === null) throw new Error('There is no draft to save.');
      const edit = draftEdit(snapshot, saved);
      if (Object.keys(edit).length === 0) return saved;
      const next = await update.mutateAsync({ draftId: saved.draft_id, edit });
      savedRef.current = next;
      return next;
    };
    // `queue` never rejects, so one failed save does not block the next.
    const result = queue.current.then(run);
    queue.current = result.catch(() => undefined);
    return result;
  };

  return {
    fields,
    change: (patch) => setFields((current) => mergeFields(current, patch)),
    save,
    saveError: update.error,
  };
}
