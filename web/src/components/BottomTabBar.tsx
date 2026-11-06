import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { ChatIcon, HomeIcon } from './icons';

export interface BottomTabBarProps {
  /** `serve` points Home at /serve and uses the Harbor active tab. */
  mode: 'support' | 'serve';
  current: 'home' | 'chat' | 'none';
  /** Render in the flow, always visible (component gallery). Otherwise fixed and phone only. */
  embedded?: boolean;
}

/** Phone only (640 px and below): two tabs, Home and Chat. */
export function BottomTabBar({ mode, current, embedded = false }: BottomTabBarProps) {
  const homeTo = mode === 'serve' ? '/serve' : '/home';
  const tab = (active: boolean) =>
    cn(
      'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-10 text-16 font-bold no-underline',
      active
        ? mode === 'serve'
          ? 'bg-harbor text-white hover:text-white'
          : 'bg-service-blue text-white hover:text-white'
        : 'text-ink hover:text-ink',
    );
  return (
    <nav
      aria-label="Primary"
      className={cn(
        'grid-cols-2 gap-2 border-t border-line bg-white px-3 pt-2 pb-[max(1.125rem,env(safe-area-inset-bottom))]',
        embedded ? 'grid' : 'fixed inset-x-0 bottom-0 z-30 hidden max-sm:grid',
      )}
    >
      <Link
        to={homeTo}
        aria-current={current === 'home' ? 'page' : undefined}
        className={tab(current === 'home')}
      >
        <HomeIcon />
        Home
      </Link>
      <Link
        to="/chat"
        aria-current={current === 'chat' ? 'page' : undefined}
        className={tab(current === 'chat')}
      >
        <ChatIcon />
        Chat
      </Link>
    </nav>
  );
}
