/** R16.4 (contributor proposal, not released): the public demo is on for this web build. */
export function isPublicDemo(): boolean {
  return import.meta.env.VITE_SUAS_PUBLIC_DEMO === 'enabled';
}

export const DEMO_BANNER_COPY =
  "Demo site. Everything here is synthetic sample data for demonstration, and nobody monitors it. Don't enter real personal information.";

export interface DemoBannerProps {
  /** Defaults to VITE_SUAS_PUBLIC_DEMO=enabled. Off renders nothing. */
  enabled?: boolean;
}

/**
 * Full-width public demo notice (R16.4, contributor proposal, not released). It sits under the
 * crisis strip on public pages and never replaces or covers it; signed-in screens keep EnvChip.
 */
export function DemoBanner({ enabled = isPublicDemo() }: DemoBannerProps) {
  if (!enabled) return null;
  return (
    <div role="note" className="border-b border-dashed border-slate bg-white text-16 text-ink">
      <p className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2 max-sm:px-4">
        <span className="inline-flex min-h-7.5 items-center rounded-pill border border-dashed border-slate px-3 py-0.5 font-bold text-slate">
          DEMO
        </span>
        <span>{DEMO_BANNER_COPY}</span>
      </p>
    </div>
  );
}
