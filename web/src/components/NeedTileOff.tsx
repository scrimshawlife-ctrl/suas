import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router';
import type { IconProps } from './Icon';
import { StatusChip } from './StatusChip';

export interface NeedTileOffProps {
  icon: ComponentType<IconProps>;
  title: string;
  /** Always says plainly that it is not available and creates no request. */
  description: ReactNode;
  /** The chip text, for example "Coming soon" or "Info only". */
  status: string;
  to: string;
}

/** A need that is not released: dashed border, Mist surface, and a labelled chip. */
export function NeedTileOff({ icon: Icon, title, description, status, to }: NeedTileOffProps) {
  return (
    <Link
      to={to}
      className="flex min-h-43 flex-col gap-3 rounded-12 border border-dashed no-underline border-slate bg-mist p-5.5 text-ink hover:border-ink hover:text-ink max-sm:min-h-30 max-sm:gap-2.5 max-sm:p-4"
    >
      <span className="flex items-start justify-between gap-2">
        <span className="grid size-12.5 place-items-center rounded-10 bg-white text-slate max-sm:size-10.5">
          <Icon size={26} />
        </span>
        <StatusChip kind="off">{status}</StatusChip>
      </span>
      <span className="text-21 font-bold">{title}</span>
      <span className="text-16 text-slate max-sm:hidden">{description}</span>
    </Link>
  );
}
