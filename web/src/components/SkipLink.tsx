/**
 * First focusable element on every screen: jumps keyboard users past the header to `#main`.
 * It moves focus into the main region itself, because a bare `#main` link only moves the
 * starting point for Tab in some browsers.
 */
export function SkipLink() {
  return (
    <a
      href="#main"
      onClick={(event) => {
        const main = document.getElementById('main');
        if (main === null) return;
        event.preventDefault();
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        main.focus();
      }}
      className="sr-only rounded-8 bg-white px-4 py-2 font-bold text-ink focus:not-sr-only focus:fixed focus:inline-flex focus:min-h-11 focus:items-center focus:top-2 focus:left-2 focus:z-50"
    >
      Skip to main content
    </a>
  );
}
