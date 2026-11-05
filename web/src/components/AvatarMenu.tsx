import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { UserIcon } from './icons';

export interface AvatarMenuProps {
  /** "Marcus T." or null before the profile is set. */
  displayName: string | null;
  tone?: 'light' | 'harbor';
  onSignOut: () => void;
}

/** Initial avatar that opens a small panel with the name and "Sign out". */
export function AvatarMenu({ displayName, tone = 'light', onSignOut }: AvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const initial = displayName?.trim().charAt(0).toUpperCase() ?? '';
  const first = displayName?.trim().split(/\s+/)[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={first ? `Account and sign out for ${first}` : 'Account and sign out'}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'grid size-11 cursor-pointer place-items-center rounded-full border-0 text-17 font-bold text-white',
          tone === 'harbor'
            ? 'bg-service-blue ring-2 ring-white hover:bg-service-blue'
            : 'bg-harbor hover:bg-service-blue',
        )}
      >
        {initial || <UserIcon size={20} />}
      </button>
      {open ? (
        <div
          id={panelId}
          className="absolute top-full right-0 z-40 mt-2 flex w-60 flex-col gap-1 rounded-12 border border-line bg-white p-2 text-ink"
        >
          {displayName ? <p className="px-3 py-2 font-bold">{displayName}</p> : null}
          <Button variant="ghost" size="small" className="justify-start" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}
