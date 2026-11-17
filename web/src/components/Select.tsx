import type { ChangeEvent, SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { FieldShell, fieldClass } from './FieldShell';
import { ChevronDownIcon } from './icons';

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export interface SelectProps<T extends string = string> extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'children' | 'value'
> {
  label: string;
  helper?: string;
  error?: string;
  options: readonly SelectOption<T>[];
  /** The chosen option's value. With a placeholder, include '' in `T`. */
  value?: T;
  /**
   * The chosen value typed as `T`, so a caller needs no cast. Called after `onChange`, and only
   * for a value in `options` (or the placeholder's '').
   */
  onValueChange?: (value: T) => void;
  /** Adds a first, empty option with this text. */
  placeholder?: string;
}

/** Native select with the shared field look, so it keeps platform pickers on phones. */
export function Select<T extends string = string>({
  label,
  helper,
  error,
  id,
  className,
  options,
  placeholder,
  onChange,
  onValueChange,
  ...select
}: SelectProps<T>) {
  // Checks the browser's string against what was rendered, since the DOM can hold options
  // the caller never gave. The placeholder's '' counts only when there is one (`T` holds it).
  const isOption = (value: string): value is T =>
    options.some((option) => option.value === value) || (placeholder !== undefined && value === '');
  const handleChange = onValueChange
    ? (event: ChangeEvent<HTMLSelectElement>) => {
        onChange?.(event);
        if (isOption(event.target.value)) onValueChange(event.target.value);
      }
    : onChange;
  return (
    <FieldShell label={label} helper={helper} error={error} id={id}>
      {(control) => (
        <div className="relative">
          <select
            className={cn(fieldClass, 'appearance-none pr-12', className)}
            {...control}
            {...select}
            onChange={handleChange}
          >
            {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-4 -translate-y-1/2" />
        </div>
      )}
    </FieldShell>
  );
}
