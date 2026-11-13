import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Button } from './Button';
import { Logo } from './Logo';
import { SkipLink } from './SkipLink';
import { cn } from '../lib/cn';

export interface AdminNavItem {
  label: string;
  to: string;
  /** Not built yet: shown as a disabled item with a "Not yet" tag. */
  soon?: boolean;
  /** The section being shown. */
  current?: boolean;
}

export interface AdminLayoutProps {
  nav: readonly AdminNavItem[];
  onSignOut: () => void;
  /** Scope line under the logo, for example the tenant and environment. */
  scope?: ReactNode;
  /** Render at natural height instead of filling the viewport (component gallery). */
  embedded?: boolean;
  children: ReactNode;
}

const itemClass =
  'flex min-h-11.5 items-center justify-between gap-2.5 rounded-8 px-3.5 font-bold no-underline';

const footerClass =
  'justify-start px-0 text-white underline hover:bg-transparent hover:text-harbor-tint';

/** Admin shell: Harbor sidebar with the white logo and "Admin", content on Mist. Base text 17 px. */
export function AdminLayout({
  nav,
  onSignOut,
  scope,
  embedded = false,
  children,
}: AdminLayoutProps) {
  return (
    <div className={cn('flex flex-wrap bg-mist text-17', !embedded && 'min-h-screen')}>
      <SkipLink />
      <aside className="flex flex-[1_1_260px] flex-col gap-6 bg-harbor px-4 py-6 text-white max-w-75 max-[700px]:max-w-none">
        <Link
          to="/admin"
          aria-label="SUAS Admin home"
          className="-my-1.5 inline-flex min-h-11 items-center gap-2.5 text-white no-underline hover:text-white"
        >
          <Logo tone="white" className="max-sm:h-8" />
          <span className="border-l-2 border-harbor-tint pl-3 font-display text-20 font-semibold text-harbor-tint">
            Admin
          </span>
        </Link>
        {scope ? (
          <p className="rounded-8 border border-service-blue px-3 py-2.5 text-16 text-harbor-tint">
            {scope}
          </p>
        ) : null}
        <nav aria-label="SUAS Admin sections" className="flex flex-col gap-1">
          {nav.map((item) =>
            item.soon ? (
              <span
                key={item.label}
                aria-disabled="true"
                className={cn(itemClass, 'text-harbor-tint')}
              >
                {item.label}
                <span className="shrink-0 rounded-pill border border-slate px-2 py-px text-16 font-bold whitespace-nowrap text-harbor-tint">
                  Not yet
                </span>
              </span>
            ) : (
              <Link
                key={item.label}
                to={item.to}
                aria-current={item.current ? 'page' : undefined}
                className={cn(
                  itemClass,
                  item.current
                    ? 'bg-white text-ink hover:text-ink'
                    : 'text-white hover:bg-service-blue hover:text-white',
                )}
              >
                {item.label}
              </Link>
            ),
          )}
        </nav>
        <div className="mt-auto flex flex-col items-start gap-1">
          {/* Back to the app Home (R12.4, contributor proposal, SUAS-specs #79). */}
          <Button variant="ghost" size="small" className={footerClass} href="/home">
            Back to SUAS
          </Button>
          <Button variant="ghost" size="small" className={footerClass} onClick={onSignOut}>
            Sign out
          </Button>
        </div>
      </aside>
      <main
        id="main"
        className="flex min-w-0 flex-[999_1_560px] flex-col gap-6 px-9 pt-8 pb-14 max-sm:px-4"
      >
        {children}
      </main>
    </div>
  );
}
