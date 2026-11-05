import type { ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface PageProps {
  /** `wide` is the 1200 px screen; `narrow` is the 640 px form screen (enter code, profile). */
  width?: 'wide' | 'narrow';
  children: ReactNode;
  className?: string;
}

/** Page container shared by every screen: width, side gutters and vertical rhythm. */
export function Page({ width = 'wide', children, className }: PageProps) {
  return (
    <div
      className={cn(
        'mx-auto flex flex-col gap-7 px-6 max-sm:px-4',
        width === 'narrow' ? 'max-w-[640px] pt-18 pb-20 max-sm:pt-8' : 'max-w-[1200px] pt-10 pb-18',
        className,
      )}
    >
      {children}
    </div>
  );
}
