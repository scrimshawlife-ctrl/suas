export interface FooterProps {
  /** The Veterans Crisis Line line appears on the Landing footer only. */
  showVeteransCrisisLine?: boolean;
}

/** Footer with the D-012 safety lines, verbatim. Links use the default link colour, as drawn. */
export function Footer({ showVeteransCrisisLine = false }: FooterProps) {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-1.5 px-6 pt-7 pb-10 text-16 text-slate max-sm:px-4">
        <p>
          SUAS coordinates community support. It does not provide emergency medical care or
          emergency dispatch.
        </p>
        <p>
          For immediate danger, call <a href="tel:911">911</a>. For suicide or emotional crisis
          support, call or text <a href="tel:988">988</a>.
        </p>
        {showVeteransCrisisLine ? (
          <p>
            Veterans Crisis Line: Dial <a href="tel:988">988</a>, then press 1 · Text{' '}
            <a href="sms:838255">838255</a>
          </p>
        ) : null}
      </div>
    </footer>
  );
}
