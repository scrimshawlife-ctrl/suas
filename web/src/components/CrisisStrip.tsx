const label = 'font-bold text-harbor-tint';
/** 44px minimum tap target (WCAG 2.2). Visible words stay the D-012 sentence. */
const link =
  'inline-flex min-h-11 min-w-11 items-center px-1 font-bold text-white underline underline-offset-3 hover:text-harbor-tint';

/**
 * The Harbor band at the top of every veteran screen, signed in or not (D-012 wording,
 * verbatim). White bold links as drawn on the boards; the SOS red buttons live in the
 * crisis panel.
 */
export function CrisisStrip() {
  return (
    <aside aria-label="Crisis support" className="bg-harbor text-16 text-white">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-8 gap-y-1.5 px-6 py-2.5 max-sm:gap-x-4 max-sm:gap-y-0.5 max-sm:px-4 max-sm:py-2">
        <p>
          <span className={label}>Emergency:</span>{' '}
          <a href="tel:911" className={link} aria-label="Call 911">
            Call 911
          </a>
        </p>
        <p>
          <span className={label}>Crisis support:</span>{' '}
          <a href="tel:988" className={link} aria-label="Call 988">
            Call
          </a>{' '}
          or{' '}
          <a href="sms:988" className={link} aria-label="Text 988">
            text 988
          </a>
        </p>
        <p>
          <span className={label}>Practical support:</span> Continue with SUAS
        </p>
      </div>
    </aside>
  );
}
