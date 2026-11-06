import { cn } from '../lib/cn';

export interface EnvChipProps {
  /** Defaults to VITE_SUAS_ENV_LABEL. With no label the chip renders nothing. */
  label?: string;
  className?: string;
}

/** Dashed slate chip that marks non-production data, for example "Synthetic demo data". */
export function EnvChip({ label = import.meta.env.VITE_SUAS_ENV_LABEL, className }: EnvChipProps) {
  if (!label) return null;
  return (
    <span
      className={cn(
        'inline-flex min-h-7.5 items-center rounded-pill border border-dashed border-slate px-3 py-0.5 text-16 font-bold text-slate',
        className,
      )}
    >
      {label}
    </span>
  );
}
