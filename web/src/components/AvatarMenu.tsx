import { useEffect, useId, useRef, useState } from 'react';
import { cn } from '../lib/cn';
import { Button } from './Button';
import { UserIcon } from './icons';

export interface AvatarMenuProps {
  /** "Marcus T." or null before the profile is set. */
  displayName: string | null;
  tone?: 'light' | 'harbor';
  /** `me.is_admin`: adds the Admin console link. The link grants nothing; the guards still check. */
  isAdmin?: boolean;
  onSignOut: () => void;
}

/**
 * Initial avatar that opens a small panel: the name, Settings, Invitations, Admin console
 * (admins only) and "Sign out" (R12.4, contributor proposal, SUAS-specs #79).
 */
export function AvatarMenu({
  displayName,
  tone = 'light',
  isAdmin = false,
  onSignOut,
}: AvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const initial = displayName?.trim().charAt(0).toUpperCase() ?? '';
  const first = displayName?.trim().split(/\s+/)[0];
  const links = [
    { label: 'Settings', to: '/settings' },
    { label: 'Invitations', to: '/invitations' },
    ...(isAdmin ? [{ label: 'Admin console', to: '/admin' }] : []),
  ];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      // Focus was inside the panel: bring it back to the button that opened it.
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative"
      onBlur={(event) => {
        // Tabbing past the panel closes it.
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
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
          {links.map((link) => (
            <Button
              key={link.to}
              variant="ghost"
              size="small"
              className="justify-start"
              href={link.to}
              onClick={() => setOpen(false)}
            >
              {link.label}
            </Button>
          ))}
          <Button variant="ghost" size="small" className="justify-start" onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}
