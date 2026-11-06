import type { CSSProperties } from 'react';
import { cn } from '../lib/cn';
import { CheckIcon } from './icons';

export interface StepperProps {
  steps: readonly string[];
  /** Zero based index of the current step. Earlier steps show a check. */
  current: number;
  /** Accessible name of the list, for example "Verification steps". */
  label: string;
}

/** Numbered step list from the Verify board. The current step has an ink border and aria-current. */
export function Stepper({ steps, current, label }: StepperProps) {
  const columns = { '--steps': `repeat(${steps.length}, minmax(0, 1fr))` } as CSSProperties;
  return (
    <ol
      aria-label={label}
      style={columns}
      className="grid grid-cols-1 gap-3 min-[861px]:grid-cols-(--steps)"
    >
      {steps.map((step, index) => {
        const isCurrent = index === current;
        const isDone = index < current;
        return (
          <li
            key={step}
            aria-current={isCurrent ? 'step' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-10 bg-white px-4 py-3.5 font-bold',
              isCurrent ? 'border-2 border-ink' : 'border border-line',
            )}
          >
            <span
              className={cn(
                'grid size-8.5 shrink-0 place-items-center rounded-full border-2 font-bold',
                isCurrent ? 'border-service-blue bg-service-blue text-white' : 'border-slate',
              )}
            >
              {isDone ? <CheckIcon size={18} strokeWidth={3} /> : index + 1}
            </span>
            {step}
          </li>
        );
      })}
    </ol>
  );
}
