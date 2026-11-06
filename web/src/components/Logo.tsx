import { cn } from '../lib/cn';

export interface LogoProps {
  /** `white` is for Harbor backgrounds. */
  tone?: 'color' | 'white';
  className?: string;
}

/**
 * The horizontal SUAS lockup. The file is placed, never retyped. It is decorative: the
 * link around it carries the name ("SUAS home"). Header height is 32 px, 28 px on phones.
 */
export function Logo({ tone = 'color', className }: LogoProps) {
  return (
    <img
      src={tone === 'white' ? '/suas-horizontal-white.svg' : '/suas-horizontal-color.svg'}
      alt=""
      className={cn('block h-8 w-auto max-sm:h-7', className)}
    />
  );
}
