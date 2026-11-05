import type { ReactNode } from 'react';
import { cn } from '../lib/cn';
import { AlertCircleIcon, CheckIcon } from './icons';

export type StatusKind = 'wait' | 'info' | 'ok' | 'warn' | 'off' | 'stale';
export type ChipMarker = 'ring' | 'dot' | 'beacon' | 'none';

const kinds: Record<StatusKind, string> = {
  wait: 'bg-white text-ink ring-1 ring-inset ring-slate',
  info: 'bg-white text-service-blue ring-2 ring-inset ring-service-blue',
  ok: 'bg-service-blue text-white',
  warn: 'bg-white text-ink ring-2 ring-inset ring-ink',
  off: 'bg-mist text-slate',
  stale: 'bg-mist text-slate ring-1 ring-inset ring-line',
};

const defaultMarker: Record<StatusKind, ChipMarker> = {
  wait: 'ring',
  info: 'dot',
  ok: 'none',
  warn: 'none',
  off: 'none',
  stale: 'none',
};

function Marker({ kind, marker }: { kind: StatusKind; marker: ChipMarker }) {
  if (kind === 'ok') return <CheckIcon size={16} strokeWidth={3} />;
  if (kind === 'warn') return <AlertCircleIcon size={16} strokeWidth={2.5} />;
  if (marker === 'ring')
    return (
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full border-2 border-current" />
    );
  if (marker === 'dot')
    return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-current" />;
  if (marker === 'beacon')
    return (
      <span
        aria-hidden="true"
        className="size-3 shrink-0 rounded-full bg-need-peer motion-safe:beacon-pulse"
      />
    );
  return null;
}

export interface StatusChipProps {
  kind: StatusKind;
  /** Shape marker next to the words. Meaning never rests on colour alone. */
  marker?: ChipMarker;
  children: ReactNode;
  className?: string;
}

/**
 * Status pill from the Components board. Brand neutrals and Service Blue only: a chip is
 * never red. A later request state is shown only once it is recorded.
 */
export function StatusChip({ kind, marker, children, className }: StatusChipProps) {
  return (
    <span
      className={cn(
        'inline-flex min-h-8 items-center gap-2 rounded-pill px-3.5 py-0.5 text-16 font-bold whitespace-nowrap',
        kinds[kind],
        className,
      )}
    >
      <Marker kind={kind} marker={marker ?? defaultMarker[kind]} />
      {children}
    </span>
  );
}
