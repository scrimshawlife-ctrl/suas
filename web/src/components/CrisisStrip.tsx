import type { ReactNode } from 'react';
import { ChatIcon, PhoneIcon } from './icons';

/**
 * Small SOS pill. The visible pill is compact; the pseudo element stretches the tap target
 * to 44 px. 2 px white edge on Harbor, phone icon, never flashes or auto-dials.
 */
function SosPill({
  href,
  label,
  children,
  text,
}: {
  href: string;
  label?: string;
  children: ReactNode;
  text?: boolean;
}) {
  return (
    <a
      href={href}
      aria-label={label}
      className="relative inline-flex min-h-7 items-center gap-1.5 rounded-pill border-2 border-white bg-sos px-2.5 font-bold text-white no-underline after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] hover:text-white hover:underline hover:underline-offset-3"
    >
      {text ? <ChatIcon size={16} /> : <PhoneIcon size={16} />}
      {children}
    </a>
  );
}

const label = 'font-bold text-harbor-tint';

/** The Harbor band at the top of every veteran screen, signed in or not (D-012 wording). */
export function CrisisStrip() {
  return (
    <aside aria-label="Crisis support" className="bg-harbor text-16 text-white">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-8 gap-y-2.5 px-6 py-2.5 max-sm:gap-x-4 max-sm:gap-y-3 max-sm:px-4">
        <p className="flex flex-wrap items-center gap-x-2">
          <span className={label}>Emergency:</span>
          <SosPill href="tel:911">Call 911</SosPill>
        </p>
        <p className="flex flex-wrap items-center gap-x-2">
          <span className={label}>Crisis support:</span>
          <SosPill href="tel:988" label="Call 988">
            Call
          </SosPill>
          <span>or</span>
          <SosPill href="sms:988" text>
            text 988
          </SosPill>
        </p>
        <p>
          <span className={label}>Practical support:</span> Continue with SUAS
        </p>
      </div>
    </aside>
  );
}
