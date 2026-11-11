import { useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useIdempotencyKey } from '../../api/idempotency';
import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { useFocusFirstInvalid } from '../../lib/focus-invalid';
import { useSingleFlight } from '../../lib/single-flight';
import { useCreateRequest } from './api';
import { gateRedirect, requestErrorMessage } from './errors';
import { InlineError } from './InlineError';
import { RequestFieldsForm } from './RequestFieldsForm';
import {
  SUMMARY_MAX,
  isCategory,
  mergeFields,
  toFormBody,
  validateRequestFields,
  type FieldErrors,
  type RequestFields,
} from './request-fields';

const MEETING_PLACE_REJECTED = /meeting[_ ]place/i;

/**
 * The plain request form: the same fields as the draft card, no assistant. After the
 * assistant fails, `fallbackSummary` carries what the person typed (cut to 280 characters).
 */
export function PlainForm({ fallbackSummary = '' }: { fallbackSummary?: string }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const initialCategory = params.get('category');
  const [fields, setFields] = useState<RequestFields>({
    category: isCategory(initialCategory) ? initialCategory : '',
    summary: '',
    timing: '',
    meetingPlace: '',
    destination: '',
  });
  // The form is filled in beside the assistant, so the fallback text fills an empty summary
  // only and never resets what the person already entered.
  const [usedFallback, setUsedFallback] = useState('');
  if (fallbackSummary !== usedFallback) {
    setUsedFallback(fallbackSummary);
    const typed = fallbackSummary.trim().slice(0, SUMMARY_MAX);
    setFields((current) =>
      typed !== '' && current.summary.trim() === '' ? { ...current, summary: typed } : current,
    );
  }
  const [errors, setErrors] = useState<FieldErrors>({});
  const create = useCreateRequest();
  const flight = useSingleFlight();
  const key = useIdempotencyKey();
  const lastPayload = useRef('');
  const formRef = useRef<HTMLFormElement>(null);
  const [attempt, setAttempt] = useState(0);
  // A failed send puts focus on the first field with a problem, so it is announced.
  useFocusFirstInvalid(formRef, `${attempt}|${Object.keys(errors).join()}`);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const found = validateRequestFields(fields);
    setErrors(found);
    setAttempt((count) => count + 1);
    if (Object.keys(found).length > 0) return;

    const body = toFormBody(fields);
    // A retry of the same content reuses the key; changed content is a new action.
    const payload = JSON.stringify(body);
    if (payload !== lastPayload.current) key.renew();
    lastPayload.current = payload;

    flight(() =>
      create.mutateAsync(
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
      ),
    );
  };

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      noValidate
      className="flex flex-col gap-5"
      aria-label="Request form"
    >
      <RequestFieldsForm
        fields={fields}
        errors={errors}
        disabled={create.isPending}
        onChange={(patch) => setFields((current) => mergeFields(current, patch))}
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
