import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronLeftIcon } from './icons';

export interface BackLinkProps {
  to: string;
  children: ReactNode;
}

/** "Back to Support" style link: chevron, bold, 44 px target. */
export function BackLink({ to, children }: BackLinkProps) {
  return (
    <Link to={to} className="inline-flex min-h-11 items-center gap-1.5 self-start font-bold">
      <ChevronLeftIcon />
      {children}
    </Link>
  );
}
