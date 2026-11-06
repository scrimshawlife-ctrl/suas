import { NEEDS } from '../../components/needs';
import { Select } from '../../components/Select';
import { TextArea } from '../../components/TextArea';
import { TextField } from '../../components/TextField';
import { CATEGORIES, MEETING_PLACE_MAX, SUMMARY_MAX, TIMING_MAX } from './request-fields';
import { meetingPlaceRequired, type FieldErrors, type RequestFields } from './request-fields';

const CATEGORY_OPTIONS = CATEGORIES.map((value) => ({ value, label: NEEDS[value].label }));

export interface RequestFieldsFormProps {
  fields: RequestFields;
  errors: FieldErrors;
  disabled?: boolean;
  onChange: (patch: Partial<RequestFields>) => void;
  /** Called when a field loses focus; the draft card saves its edits here. */
  onBlur?: () => void;
}

/**
 * The four request fields, shared by the draft card and the plain form so the meeting-place
 * rule and the limits are stated once.
 */
export function RequestFieldsForm({
  fields,
  errors,
  disabled,
  onChange,
  onBlur,
}: RequestFieldsFormProps) {
  const required = meetingPlaceRequired(fields.category);
  return (
    <div className="flex flex-col gap-5">
      <Select
        label="What kind of help do you need?"
        placeholder="Choose one"
        options={CATEGORY_OPTIONS}
        value={fields.category}
        error={errors.category}
        disabled={disabled}
        onChange={(event) =>
          onChange({ category: event.target.value as RequestFields['category'] })
        }
        onBlur={onBlur}
      />
      <TextArea
        label="Short summary"
        helper={`A sentence or two. Up to ${SUMMARY_MAX} characters.`}
        rows={3}
        maxLength={SUMMARY_MAX}
        value={fields.summary}
        error={errors.summary}
        disabled={disabled}
        onChange={(event) => onChange({ summary: event.target.value })}
        onBlur={onBlur}
      />
      <TextField
        label="When do you need it? (optional)"
        helper={`For example, today after 3 pm. Up to ${TIMING_MAX} characters.`}
        maxLength={TIMING_MAX}
        value={fields.timing}
        error={errors.timing}
        disabled={disabled}
        onChange={(event) => onChange({ timing: event.target.value })}
        onBlur={onBlur}
      />
      <TextField
        label="Where should the helper meet you?"
        helper={
          required
            ? `Required for this kind of request. Only you and the person who accepts it see this. Up to ${MEETING_PLACE_MAX} characters.`
            : `Optional. Only you and the person who accepts it see this. Up to ${MEETING_PLACE_MAX} characters.`
        }
        maxLength={MEETING_PLACE_MAX}
        required={required}
        value={fields.meetingPlace}
        error={errors.meetingPlace}
        disabled={disabled}
        onChange={(event) => onChange({ meetingPlace: event.target.value })}
        onBlur={onBlur}
      />
    </div>
  );
}
