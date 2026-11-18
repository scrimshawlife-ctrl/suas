import { useRef, useState, type ClipboardEvent } from 'react';
import { cn } from '../lib/cn';

const LENGTH = 6;

export interface CodeInputProps {
  /** Receives the control id, `aria-describedby` and `aria-invalid` from `FieldShell`. */
  id: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: true | undefined;
  /** The digits entered so far, already cleaned. */
  value: string;
  /** Gets the raw text from the field; the caller cleans it (see `cleanCode`). */
  onChange: (raw: string) => void;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  name?: string;
}

/**
 * Six boxes, one digit each. One real input sits on top with transparent text, so typing, paste,
 * one-time-code autofill and the single screen-reader label keep working. The boxes only show
 * `value`, so a digit is centred in its box at any width.
 */
export function CodeInput({
  value,
  onChange,
  onPaste,
  name = 'code',
  'aria-invalid': invalid,
  ...control
}: CodeInputProps) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const active = Math.min(value.length, LENGTH - 1);

  // Keep the caret at the end so typing and Backspace always act on the last box. A range
  // selection (select all, then delete or type over) is left alone, or it could not be cleared.
  const caretToEnd = (force = false) => {
    const input = inputRef.current;
    if (!input) return;
    const end = input.value.length;
    if (force || (input.selectionStart === input.selectionEnd && input.selectionStart !== end)) {
      input.setSelectionRange(end, end);
    }
  };

  return (
    <div className="relative">
      <div aria-hidden="true" className="grid grid-cols-6 gap-2 max-sm:gap-1.5">
        {Array.from({ length: LENGTH }, (_, index) => (
          <div
            key={index}
            data-cell
            className={cn(
              'font-display flex min-h-21 items-center justify-center rounded-10 border-2 border-ink bg-white text-44 font-bold tabular-nums max-sm:min-h-16 max-sm:text-28',
              invalid && 'border-[3px]',
              focused && index === active && 'border-service-blue ring-2 ring-service-blue',
            )}
          >
            {value[index] ??
              (focused && index === active ? (
                <span className="h-9 w-0.5 bg-service-blue motion-safe:animate-pulse" />
              ) : null)}
          </div>
        ))}
      </div>
      <input
        {...control}
        ref={inputRef}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={LENGTH}
        pattern="[0-9]{6}"
        required
        aria-invalid={invalid}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={onPaste}
        onFocus={() => {
          setFocused(true);
          caretToEnd(true);
        }}
        onBlur={() => setFocused(false)}
        onSelect={() => caretToEnd()}
        className="absolute inset-0 h-full w-full cursor-text bg-transparent text-transparent caret-transparent outline-none"
      />
    </div>
  );
}
