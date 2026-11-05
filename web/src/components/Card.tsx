import type { ElementType, HTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  /** 2 px ink border, used for the one card that matters on a screen (active request, accepted case). */
  emphasis?: boolean;
  /** Padding in px, as drawn: 20, 24, 28, 32, 36 or 40. */
  padding?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
}

const paddings = { none: '', sm: 'p-5', md: 'p-6', lg: 'p-7', xl: 'p-9' };

/** White surface with a Line hairline and 12 px radius. Flat: no shadow. */
export function Card({
  as: Tag = 'section',
  emphasis = false,
  padding = 'md',
  className,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={cn(
        'rounded-12 bg-card',
        emphasis ? 'border-2 border-ink' : 'border border-line',
        paddings[padding],
        className,
      )}
      {...rest}
    />
  );
}
