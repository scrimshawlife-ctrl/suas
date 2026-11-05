import { Link } from 'react-router';
import { Button } from './Button';
import { EnvChip } from './EnvChip';
import { Logo } from './Logo';

export interface PublicHeaderProps {
  /** When set, the right side shows "Sign out" instead of "Sign in". */
  onSignOut?: () => void;
  /** Hide the Sign in button (sign-in screens). */
  hideSignIn?: boolean;
}

/** Header for signed-out and onboarding screens: logo, optional env chip, Sign in. */
export function PublicHeader({ onSignOut, hideSignIn = false }: PublicHeaderProps) {
  return (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-7 gap-y-3 px-6 py-3.5 max-sm:gap-x-3 max-sm:px-4 max-sm:py-2.5">
        <Link to="/" aria-label="SUAS home" className="inline-flex items-center">
          <Logo />
        </Link>
        <EnvChip />
        {onSignOut ? (
          <Button variant="secondary" size="small" className="ml-auto" onClick={onSignOut}>
            Sign out
          </Button>
        ) : hideSignIn ? null : (
          <Button variant="secondary" size="small" className="ml-auto" href="/sign-in">
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}
