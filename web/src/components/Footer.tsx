export interface FooterProps {
  /**
   * The Landing footer adds the "Dial 988, then press 1" line. Every footer carries the
   * SAFETY_COPY.md §2.3 Veterans Crisis Line text link (D-050).
   */
  showVeteransCrisisLine?: boolean;
}

/** 44px minimum tap target. Visible words stay the D-012 sentence; colour stays the default link colour. */
const crisisLink = 'inline-flex min-h-11 min-w-11 items-center px-1';

/**
 * Footer with the SAFETY_COPY.md §2.3 persistent footer lines (D-012, D-050), verbatim.
 * Links use the default link colour, as drawn.
 */
export function Footer({ showVeteransCrisisLine = false }: FooterProps) {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-1.5 px-6 pt-7 pb-10 text-16 text-slate max-sm:px-4">
        <p>
          SUAS coordinates community support. It does not provide emergency medical care or
          emergency dispatch.
        </p>
        <p>
          For immediate danger,{' '}
          <a href="tel:911" className={crisisLink} aria-label="Call 911">
            call 911
          </a>
          . For suicide or emotional crisis support,{' '}
          <a href="tel:988" className={crisisLink} aria-label="Call 988">
            call
          </a>{' '}
          or{' '}
          <a href="sms:988" className={crisisLink} aria-label="Text 988">
            text 988
          </a>
          . Veterans Crisis Line:{' '}
          <a
            href="sms:838255"
            className={crisisLink}
            aria-label="Veterans Crisis Line: Text 838255"
          >
            Text 838255
          </a>
          .
        </p>
        {showVeteransCrisisLine ? (
          <p>
            <a href="tel:988" className={crisisLink}>
              Dial 988
            </a>
            , then press 1
          </p>
        ) : null}
      </div>
    </footer>
  );
}
