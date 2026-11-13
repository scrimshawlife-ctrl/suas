import { useRef } from 'react';
import { Button } from '../../components/Button';
import { AlertCircleIcon } from '../../components/icons';
import { cn } from '../../lib/cn';

export interface PhotoPickerProps {
  id: string;
  /** "Front of your licence": the field name, read before the action. */
  label: string;
  helper: string;
  /** Object URL of the prepared JPEG, or null before a photo is added. */
  previewUrl: string | null;
  preparing: boolean;
  error?: string | undefined;
  onPick: (file: File) => void;
  onClear: () => void;
}

const pickClass =
  'inline-flex min-h-13 cursor-pointer items-center justify-center rounded-8 border-2 border-ink bg-white px-5.5 text-18 font-bold text-ink select-none hover:bg-mist peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-service-blue peer-aria-invalid:border-[3px]';

/**
 * One side of the licence (L2.2): camera or files (`capture` opens the back camera on phones), a
 * preview of exactly what will be sent, and replace or remove. The native input stays in the
 * tab order; its styled label is what people see and press.
 */
export function PhotoPicker({
  id,
  label,
  helper,
  previewUrl,
  preparing,
  error,
  onPick,
  onClear,
}: PhotoPickerProps) {
  const input = useRef<HTMLInputElement>(null);
  const describedBy = [`${id}-helper`, error ? `${id}-error` : null].filter(Boolean).join(' ');
  const action = previewUrl === null ? 'Take or choose a photo' : 'Replace photo';

  return (
    <div className="flex flex-col gap-2.5">
      <p id={`${id}-label`} className="text-17 font-bold">
        {label}
      </p>
      <p id={`${id}-helper`} className="text-16 text-slate">
        {helper}
      </p>
      {previewUrl !== null ? (
        <img
          src={previewUrl}
          alt={`${label}, as it will be sent`}
          className="max-h-60 w-auto self-start rounded-8 border border-line"
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          id={id}
          type="file"
          accept="image/*"
          capture="environment"
          className="peer sr-only"
          aria-labelledby={`${id}-label ${id}-action`}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          disabled={preparing}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared so picking the same file again still fires a change.
            event.target.value = '';
            if (file !== undefined) onPick(file);
          }}
        />
        <label
          htmlFor={id}
          id={`${id}-action`}
          className={cn(pickClass, preparing && 'cursor-wait text-slate')}
        >
          {preparing ? 'Preparing photo…' : action}
        </label>
        {previewUrl !== null && !preparing ? (
          <Button
            id={`${id}-remove`}
            variant="ghost"
            size="small"
            aria-labelledby={`${id}-remove ${id}-label`}
            onClick={() => {
              onClear();
              input.current?.focus();
            }}
          >
            Remove photo
          </Button>
        ) : null}
      </div>
      {error ? (
        <p id={`${id}-error`} className="flex items-center gap-2 text-16 font-bold">
          <AlertCircleIcon size={20} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
