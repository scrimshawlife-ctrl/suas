import type { SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';
import { FieldShell, fieldClass } from './FieldShell';
import { ChevronDownIcon } from './icons';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  label: string;
  helper?: string;
  error?: string;
  options: readonly SelectOption[];
  /** Adds a first, empty option with this text. */
  placeholder?: string;
}

/** Native select with the shared field look, so it keeps platform pickers on phones. */
export function Select({
  label,
  helper,
  error,
  id,
  className,
  options,
  placeholder,
  ...select
}: SelectProps) {
  return (
    <FieldShell label={label} helper={helper} error={error} id={id}>
      {(control) => (
        <div className="relative">
          <select
            className={cn(fieldClass, 'appearance-none pr-12', className)}
            {...control}
            {...select}
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
