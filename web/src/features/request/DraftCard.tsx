import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useIdempotencyKey } from '../../api/idempotency';
import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { useSubmitDraft, type IntakeDraft } from './api';
import type { DraftEditor } from './draft-editor';
import { gateRedirect, requestErrorMessage } from './errors';
import { InlineError } from './InlineError';
import { RequestFieldsForm } from './RequestFieldsForm';
import { validateRequestFields, type FieldErrors } from './request-fields';

const MEETING_PLACE_REJECTED = /meeting[_ ]place/i;

/**
 * The editable draft. Nothing is a request until "Send request": edits are saved with PATCH
 * when a field loses focus and again just before the submit.
 */
export function DraftCard({ draft, editor }: { draft: IntakeDraft; editor: DraftEditor }) {
  const navigate = useNavigate();
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const key = useIdempotencyKey();
  const submit = useSubmitDraft();
  const [saving, setSaving] = useState(false);
  const fieldsRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  useFocusFirstInvalid(fieldsRef, `${attempt}|${Object.keys(errors).join()}`);

  const saveQuietly = () => {
    editor.save().catch(() => undefined);
  };

  const onSend = async () => {
    const found = validateRequestFields(editor.fields);
    setErrors(found);
    setAttempt((count) => count + 1);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    try {
      const saved = await editor.save();
      const result = await submit.mutateAsync({
        draftId: saved.draft_id,
        idempotencyKey: key.current(),
      });
      key.renew();
      void navigate(paths.requestDetail(result.service_request_id));
    } catch (error) {
      const gate = gateRedirect(error);
      if (gate) void navigate(gate, { replace: true });
      else if (
        isApiError(error) &&
        error.status === 422 &&
        MEETING_PLACE_REJECTED.test(error.message)
      ) {
        setErrors({ meetingPlace: 'Tell us where the helper should meet you.' });
      } else setFailure(error);
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || submit.isPending;
  const shownError = failure ?? editor.saveError;
  return (
    <Card
      aria-labelledby={`draft-${draft.draft_id}`}
      emphasis
      padding="lg"
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-1.5">
        <h2 id={`draft-${draft.draft_id}`} className="heading text-26">
          Check your request
        </h2>
        <p className="text-slate">
          This is a draft. Change anything that is wrong. Nothing is sent until you choose Send
          request.
        </p>
      </div>
      <div ref={fieldsRef} className="contents">
        <RequestFieldsForm
          fields={editor.fields}
          errors={errors}
          disabled={busy}
          onChange={editor.change}
          onBlur={saveQuietly}
        />
      </div>
      {shownError ? <InlineError>{requestErrorMessage(shownError)}</InlineError> : null}
      <div className="flex">
        <Button size="form" disabled={busy} onClick={() => void onSend()}>
          {busy ? 'Sending…' : 'Send request'}
        </Button>
      </div>
    </Card>
  );
}
