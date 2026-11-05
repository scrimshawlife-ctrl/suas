import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Pixel size. Boards use 22 for UI, 26 to 28 inside tiles, 14 to 20 inside chips. */
  size?: number;
  strokeWidth?: number;
  /** Set when the icon is the only label; otherwise it is hidden from assistive tech. */
  title?: string;
}

/** Lucide-style line icon base: 24 unit grid, stroke 2, round caps. */
export function Icon({
  size = 22,
  strokeWidth = 2,
  title,
  children,
  ...rest
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
      focusable="false"
      {...rest}
      className={`shrink-0 ${rest.className ?? ''}`.trim()}
    >
      {children}
    </svg>
  );
}
