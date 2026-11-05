import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '../lib/cn';
import { NEEDS, type NeedCategory } from './needs';

export interface NeedTileProps {
  category: NeedCategory;
  to: string;
  /** Defaults to the category label. */
  title?: string;
  description?: ReactNode;
  /** `tile` is the filled card; `row` is the white one-line card used under a request. */
  appearance?: 'tile' | 'row';
  /** Short line shown on phones in place of the description (Phone board), e.g. "Temporary shelter". */
  phoneTag?: string;
  className?: string;
}

/** A released need: filled with the need colour, white icon and label. Never red. */
export function NeedTile({
  category,
  to,
  title,
  description,
  appearance = 'tile',
  phoneTag,
  className,
}: NeedTileProps) {
  const need = NEEDS[category];
  const Icon = need.Icon;
  const name = title ?? need.label;

  if (appearance === 'row') {
    return (
      <Link
        to={to}
        className={cn(
          'flex min-h-18 items-center gap-3.5 no-underline rounded-12 border border-line bg-white px-4.5 py-4 font-bold text-ink hover:border-ink hover:text-ink',
          className,
        )}
      >
        <span className={cn('grid size-10 place-items-center rounded-10 text-white', need.fill)}>
          <Icon />
        </span>
        {name}
      </Link>
    );
  }

  return (
    <Link
      to={to}
      className={cn(
        'flex min-h-43 flex-col gap-3 rounded-12 border p-5.5 no-underline text-white hover:text-white hover:shadow-[inset_0_0_0_3px_#fff,0_0_0_2px_#101828] max-sm:min-h-30 max-sm:gap-2.5 max-sm:p-4',
        need.fill,
        need.border,
        className,
      )}
    >
      <span className="grid size-12.5 place-items-center rounded-10 bg-white/15 max-sm:size-10.5">
        <Icon size={26} />
      </span>
      <span className="text-21 font-bold">{name}</span>
      {description ? <span className="text-16 max-sm:hidden">{description}</span> : null}
      {phoneTag ? <span className="hidden text-16 font-bold max-sm:block">{phoneTag}</span> : null}
    </Link>
  );
}
