import type { ReactNode } from 'react';
import { RadioCard } from './RadioCard';

export interface RadioCardOption {
  value: string;
  title: ReactNode;
  description?: ReactNode;
}

export interface RadioCardGroupProps {
  legend: ReactNode;
  /** Optional sentence under the legend. */
  hint?: ReactNode;
  name: string;
  options: readonly RadioCardOption[];
  value?: string;
  onValueChange?: (value: string) => void;
}

/** A fieldset of RadioCards: one answer per question. */
export function RadioCardGroup({
  legend,
  hint,
  name,
  options,
  value,
  onValueChange,
}: RadioCardGroupProps) {
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-4">
        <span className="block text-20 font-bold">{legend}</span>
        {hint ? <span className="mt-2 block text-slate">{hint}</span> : null}
      </legend>
      {options.map((option) => (
        <RadioCard
          key={option.value}
          name={name}
          value={option.value}
          title={option.title}
          description={option.description}
          checked={value === undefined ? undefined : value === option.value}
          onChange={onValueChange ? () => onValueChange(option.value) : undefined}
        />
      ))}
    </fieldset>
  );
}
