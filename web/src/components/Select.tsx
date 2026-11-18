import type { ChangeEvent, SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { FieldShell, fieldClass } from './FieldShell';
import { ChevronDownIcon } from './icons';

interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/** The value a Select holds or emits: an option's, or the placeholder's '' when it has one. */
type SelectValue<T extends string, P extends string | undefined> = P extends string ? T | '' : T;

export interface SelectProps<
  T extends string = string,
  P extends string | undefined = undefined,
> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'value' | 'placeholder'> {
  label: string;
  helper?: string;
  error?: string;
  /** The options; `T` is inferred from these alone. */
  options: readonly SelectOption<T>[];
  /** The chosen option's value, or '' for the placeholder (only when there is one). */
  value?: NoInfer<SelectValue<T, P>>;
  /**
   * The chosen value, typed so a caller needs no cast: an option's value, or the placeholder's ''
   * (only when there is one). Called after `onChange`, and only for one of those values.
   */
  onValueChange?: (value: NoInfer<SelectValue<T, P>>) => void;
  /** Adds a first, empty option with this text. */
  placeholder?: P;
}

/** Native select with the shared field look, so it keeps platform pickers on phones. */
export function Select<T extends string = string, P extends string | undefined = undefined>({
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
}: SelectProps<T, P>) {
  // Checks the browser's string against what was rendered, since the DOM can hold options
  // the caller never gave. The placeholder's '' counts only when there is one, as in `SelectValue`.
  const isValue = (value: string): value is SelectValue<T, P> =>
    options.some((option) => option.value === value) || (placeholder !== undefined && value === '');
  const handleChange = onValueChange
    ? (event: ChangeEvent<HTMLSelectElement>) => {
        onChange?.(event);
        if (isValue(event.target.value)) onValueChange(event.target.value);
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
