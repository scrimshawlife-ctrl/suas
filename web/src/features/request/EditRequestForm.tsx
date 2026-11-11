import { useRef, useState, type FormEvent } from 'react';
import { isApiError } from '../../api/errors';
import { useIdempotencyKey } from '../../api/idempotency';
import type { ServiceRequestDetail } from '../../api/types';
import { Button } from '../../components/Button';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { useSingleFlight } from '../../lib/single-flight';
import { useEditRequest } from './api';
import { requestErrorMessage } from './errors';
import { InlineError } from './InlineError';
import { RequestFieldsForm } from './RequestFieldsForm';
import {
  fieldsFromDetail,
  mergeFields,
  requestEdit,
  validateRequestFields,
  type FieldErrors,
} from './request-fields';

const MEETING_PLACE_REJECTED = /meeting[_ ]place/i;

export interface EditRequestFormProps {
  request: ServiceRequestDetail;
  onDone: () => void;
}

/**
 * Edits a request nobody has accepted. The category is fixed; only the fields that changed
 * are sent, and an emptied optional field is sent as null to clear it.
 */
export function EditRequestForm({ request, onDone }: EditRequestFormProps) {
  const [fields, setFields] = useState(() => fieldsFromDetail(request));
  const [errors, setErrors] = useState<FieldErrors>({});
  const edit = useEditRequest(request.service_request_id);
  const flight = useSingleFlight();
  const key = useIdempotencyKey();
  const lastPayload = useRef('');
  const formRef = useRef<HTMLFormElement>(null);
  const [attempt, setAttempt] = useState(0);
  useFocusFirstInvalid(formRef, `${attempt}|${Object.keys(errors).join()}`);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateRequestFields(fields);
    setErrors(found);
    setAttempt((count) => count + 1);
    if (Object.keys(found).length > 0) return;

    const changes = requestEdit(fields, request);
    if (Object.keys(changes).length === 0) {
      onDone();
      return;
    }
    // A retry of the same content reuses the key; changed content is a new action.
    const payload = JSON.stringify(changes);
    if (payload !== lastPayload.current) key.renew();
    lastPayload.current = payload;

    flight(() =>
      edit.mutateAsync(
        { edit: changes, idempotencyKey: key.current() },
        {
          onSuccess: () => {
            key.renew();
            onDone();
          },
          onError: (error) => {
            if (
              isApiError(error) &&
              error.status === 422 &&
              MEETING_PLACE_REJECTED.test(error.message)
            ) {
              setErrors({ meetingPlace: 'Tell us where the helper should meet you.' });
            }
          },
        },
      ),
    );
  };

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-5"
      aria-label="Edit request"
    >
      <RequestFieldsForm
        fields={fields}
        errors={errors}
        disabled={edit.isPending}
        categoryLocked
        onChange={(patch) => setFields((current) => mergeFields(current, patch))}
      />
      {edit.isError ? <InlineError>{requestErrorMessage(edit.error)}</InlineError> : null}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" size="form" disabled={edit.isPending}>
          {edit.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="secondary" size="form" disabled={edit.isPending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
