/** First focusable element on every screen: jumps keyboard users past the header to `#main`. */
export function SkipLink() {
  return (
    <a
      href="#main"
      className="sr-only rounded-8 bg-white px-4 py-2 font-bold text-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
    >
      Skip to main content
    </a>
  );
}
