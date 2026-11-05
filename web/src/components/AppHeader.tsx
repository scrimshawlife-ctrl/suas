import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { AvatarMenu } from './AvatarMenu';
import { EnvChip } from './EnvChip';
import { ChatIcon, HomeIcon } from './icons';
import { Logo } from './Logo';
import { ModeSwitch, type Mode } from './ModeSwitch';

export interface AppHeaderProps {
  mode: Mode;
  /** Which nav item is current. `none` on screens that belong to neither (notifications, crisis). */
  current: 'home' | 'chat' | 'none';
  displayName: string | null;
  onSignOut: () => void;
  onModeSelect?: (mode: Mode) => void;
  /** Unread chat messages. Shown as a number badge on Chat when above zero. */
  chatUnread?: number;
}

/** Shared header body for the two signed-in chromes. `tone` follows the mode. */
function AppHeader({
  mode,
  current,
  displayName,
  onSignOut,
  onModeSelect,
  chatUnread = 0,
}: AppHeaderProps) {
  const harbor = mode === 'serve';
  const homeTo = harbor ? '/serve' : '/home';
  const link = (active: boolean) =>
    cn(
      'inline-flex min-h-11 items-center gap-2 rounded-8 px-4 font-bold no-underline',
      harbor
        ? active
          ? 'bg-white text-harbor hover:text-harbor'
          : 'text-white hover:bg-service-blue hover:text-white'
        : active
          ? 'bg-service-blue text-white hover:text-white'
          : 'text-ink hover:bg-mist hover:text-ink',
    );

  return (
    <header
      className={cn(
        harbor
          ? 'border-y border-t-service-blue border-b-harbor bg-harbor'
          : 'border-b border-line bg-white',
      )}
    >
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3 max-sm:flex-nowrap max-sm:justify-between max-sm:gap-x-3 max-sm:px-4 max-sm:py-2.5">
        <Link to={homeTo} aria-label="SUAS home" className="inline-flex min-h-11 items-center">
          <Logo tone={harbor ? 'white' : 'color'} />
        </Link>
        <nav aria-label="Primary" className="flex gap-1 max-sm:hidden">
          <Link
            to={homeTo}
            aria-current={current === 'home' ? 'page' : undefined}
            className={link(current === 'home')}
          >
            <HomeIcon />
            Home
          </Link>
          <Link
            to="/chat"
            aria-current={current === 'chat' ? 'page' : undefined}
            className={link(current === 'chat')}
          >
            <ChatIcon />
            Chat
            {chatUnread > 0 ? (
              <span
                role="img"
                aria-label={`${chatUnread} unread`}
                className="inline-grid h-6 min-w-6 place-items-center rounded-full bg-service-blue px-1.5 text-16 font-bold text-white"
              >
                {chatUnread}
              </span>
            ) : null}
          </Link>
        </nav>
        <EnvChip className="max-sm:hidden" />
        <ModeSwitch
          mode={mode}
          tone={harbor ? 'harbor' : 'light'}
          onSelect={onModeSelect}
          className="ml-auto max-sm:hidden"
        />
        <AvatarMenu
          displayName={displayName}
          tone={harbor ? 'harbor' : 'light'}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  );
}

export { AppHeader };
