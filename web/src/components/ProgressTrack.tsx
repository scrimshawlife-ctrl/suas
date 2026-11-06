import { cn } from '../lib/cn';
import { CheckIcon } from './icons';

export interface ProgressStep {
  label: string;
  /** Time or "Not yet". Only real, recorded facts belong here. */
  detail?: string;
  state: 'done' | 'now' | 'todo';
}

export interface ProgressTrackProps {
  steps: readonly ProgressStep[];
  label: string;
}

/**
 * Request progress from the QrfActive board. Peer Support teal marks what is recorded; the
 * current step carries a beacon that pulses only when the person allows motion.
 */
export function ProgressTrack({ steps, label }: ProgressTrackProps) {
  return (
    <ol aria-label={label} className="grid grid-cols-4 max-sm:grid-cols-1 max-sm:gap-1">
      {steps.map((step) => (
        <li
          key={step.label}
          aria-current={step.state === 'now' ? 'step' : undefined}
          className={cn(
            "relative flex flex-col gap-2 pt-7 before:absolute before:top-2.5 before:right-0 before:left-0 before:h-1 before:content-['']",
            step.state === 'done' && 'before:bg-need-peer',
            step.state === 'now' && 'before:bg-[linear-gradient(90deg,#2E7A73_50%,#D8DEE8_50%)]',
            step.state === 'todo' && 'before:bg-line',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-0 left-0 grid size-6 place-items-center rounded-full border-[3px] bg-white',
              step.state === 'done' && 'border-need-peer bg-need-peer text-white',
              step.state === 'now' && 'border-need-peer',
              step.state === 'todo' && 'border-line',
            )}
          >
            {step.state === 'done' ? <CheckIcon size={14} strokeWidth={3.5} /> : null}
            {step.state === 'now' ? (
              <span className="size-2.5 rounded-full bg-need-peer motion-safe:beacon-pulse" />
            ) : null}
          </span>
          <span className={cn('font-bold', step.state === 'todo' && 'text-slate')}>
            {step.label}
          </span>
          {step.detail ? <span className="text-16 text-slate">{step.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}
