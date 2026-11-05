import { Link } from 'react-router';
import { cn } from '../lib/cn';

export type Mode = 'support' | 'serve';

export interface ModeSwitchProps {
  mode: Mode;
  tone?: 'light' | 'harbor';
  /** Full width segmented control for the phone layout. */
  fullWidth?: boolean;
  /** Called when a segment is chosen, so the app can remember the last mode. */
  onSelect?: (mode: Mode) => void;
  className?: string;
}

const segments: { mode: Mode; label: string; to: string }[] = [
  { mode: 'support', label: 'Need support', to: '/home' },
  { mode: 'serve', label: 'Serve', to: '/serve' },
];

/** "Need support | Serve" segmented control. Need support goes to /home, Serve to /serve. */
export function ModeSwitch({
  mode,
  tone = 'light',
  fullWidth = false,
  onSelect,
  className,
}: ModeSwitchProps) {
  const harbor = tone === 'harbor';
  return (
    <nav
      aria-label="Mode"
      className={cn(
        'gap-0.5 rounded-pill border p-[3px]',
        fullWidth ? 'flex' : 'inline-flex',
        harbor ? 'border-harbor-tint' : 'border-slate',
        className,
      )}
    >
      {segments.map((segment) => {
        const current = segment.mode === mode;
        return (
          <Link
            key={segment.mode}
            to={segment.to}
            aria-current={current ? 'page' : undefined}
            onClick={() => onSelect?.(segment.mode)}
            className={cn(
              'inline-flex min-h-11 items-center justify-center rounded-pill px-4 text-16 font-bold no-underline',
              fullWidth && 'flex-1',
              current
                ? harbor
                  ? 'bg-white text-harbor hover:text-harbor'
                  : 'bg-service-blue text-white hover:text-white'
                : harbor
                  ? 'text-white hover:bg-service-blue hover:text-white'
                  : 'text-ink hover:bg-mist hover:text-ink',
            )}
          >
            {segment.label}
          </Link>
        );
      })}
    </nav>
  );
}
