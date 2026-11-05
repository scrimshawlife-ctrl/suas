import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useIdempotencyKey } from '../../api/idempotency';
import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { useCreateRequest } from './api';
import { gateRedirect, requestErrorMessage } from './errors';
import { InlineError } from './InlineError';
import { RequestFieldsForm } from './RequestFieldsForm';
import {
  isCategory,
  toFormBody,
  validateRequestFields,
  type FieldErrors,
  type RequestFields,
} from './request-fields';

const MEETING_PLACE_REJECTED = /meeting[_ ]place/i;

/** The plain request form: the same fields as the draft card, no assistant. */
export function PlainForm() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const initialCategory = params.get('category');
  const [fields, setFields] = useState<RequestFields>({
    category: isCategory(initialCategory) ? initialCategory : '',
    summary: '',
    timing: '',
    meetingPlace: '',
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const create = useCreateRequest();
  const key = useIdempotencyKey();
  const lastPayload = useRef('');

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateRequestFields(fields);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const body = toFormBody(fields);
    // A retry of the same content reuses the key; changed content is a new action.
    const payload = JSON.stringify(body);
    if (payload !== lastPayload.current) key.renew();
    lastPayload.current = payload;

    create.mutate(
      { body, idempotencyKey: key.current() },
      {
        onSuccess: (created) => {
          key.renew();
          void navigate(paths.requestDetail(created.service_request_id));
        },
        onError: (error) => {
          const gate = gateRedirect(error);
          if (gate) void navigate(gate, { replace: true });
          else if (
            isApiError(error) &&
            error.status === 422 &&
            MEETING_PLACE_REJECTED.test(error.message)
          ) {
            setErrors({ meetingPlace: 'Tell us where the helper should meet you.' });
          }
        },
      },
    );
  };

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5" aria-label="Request form">
      <RequestFieldsForm
        fields={fields}
        errors={errors}
        disabled={create.isPending}
        onChange={(patch) => setFields((current) => ({ ...current, ...patch }))}
      />
      {create.isError && gateRedirect(create.error) === undefined ? (
        <InlineError>{requestErrorMessage(create.error)}</InlineError>
      ) : null}
      <div className="flex">
        <Button type="submit" size="form" disabled={create.isPending}>
          {create.isPending ? 'Sending…' : 'Send request'}
        </Button>
      </div>
    </form>
  );
}
