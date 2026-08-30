/**
 * Presentation rules, as one inlined stylesheet.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §4 (action first, low cognitive load, mobile
 *   first, strong operational states, no enterprise-density drift)
 * - SUAS-specs MVP_REFERENCE.md §10 (WCAG 2.2 AA: focus visible, large touch
 *   targets, text zoom/reflow, non-color-only meaning, reduced motion)
 * - SUAS-specs MVP_REFERENCE.md §13 (non-goal: freezing CSS/framework technology)
 *
 * Colors, type, radii, and surface hierarchy mirror the native iOS client
 * (`suas-ios/suas/suas/ContentView.swift`, `LoginView.swift`, and
 * `HomeView.swift`). Accessibility floors stay WCAG 2.2 AA values: 24x24 CSS px minimum
 * target size (2.5.8), visible focus (2.4.7, 2.4.11), reflow at 320 CSS px
 * (1.4.10), and text spacing tolerance (1.4.12).
 *
 * Contrast: primary text `#1c1c1e` on white is 17.01:1; secondary text
 * `#636366` on white is 5.99:1; service blue `#1c529e` on white is 7.64:1.
 */

/**
 * Minimum target size in CSS pixels. WCAG 2.2 AA 2.5.8 sets 24; the reference's
 * "large action targets" (§4.2) and mobile-first critical paths (§4.7) justify
 * the larger floor on primary actions.
 */
export const MIN_TARGET_PX = 24;
export const PRIMARY_TARGET_PX = 48;

/** Native iOS theme tokens, observed from `suas-ios` SwiftUI source. */
export const IOS_GROUPED_BG = '#f2f2f7';
export const IOS_TEXT = '#1c1c1e';
export const IOS_ACCENT = '#1c529e';
export const IOS_TRANSPORTATION = '#2173b8';
export const IOS_FOOD = '#cc731a';
export const IOS_SHELTER = '#40804d';

export const STYLESHEET = `
:root {
  --bg: ${IOS_GROUPED_BG};
  --surface: #ffffff;
  --bone: ${IOS_TEXT};
  --bone-soft: #3a3a3c;
  --bone-dim: #636366;
  --olive: ${IOS_ACCENT};
  --olive-deep: #17447f;
  --transportation: ${IOS_TRANSPORTATION};
  --food: ${IOS_FOOD};
  --shelter: ${IOS_SHELTER};
  --danger: #c72626;
  --line: rgba(60, 60, 67, 0.18);
  --line-strong: rgba(60, 60, 67, 0.32);
  --plate: #ffffff;
  --focus: ${IOS_ACCENT};
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', system-ui, sans-serif;
  --font-serif: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SFMono-Regular', ui-monospace, 'Cascadia Mono', Consolas, monospace;
  color-scheme: light;
}

*, *::before, *::after { box-sizing: border-box; }

html { color-scheme: light; background: var(--bg); }

body {
  margin: 0;
  /* Relative units so text zoom and reflow (1.4.10, 1.4.4) work. */
  font: 1rem/1.5 var(--font-sans);
  color: var(--bone);
  background: var(--bg);
  min-width: 320px;
}

/* 1.4.12 text spacing: never clip on user-adjusted spacing. */
p, li, dd { overflow-wrap: break-word; }

.shell {
  position: relative;
  max-width: 38rem;
  margin: 0 auto;
  /* Room for the fixed bottom nav so it never covers the last action.
     Safe-area inset keeps primary actions clear of a notched home indicator. */
  padding: 1rem 1rem calc(5.5rem + env(safe-area-inset-bottom, 0px));
}

.site-chrome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin: 0 0 1.25rem;
  padding: 0.75rem 0.9rem;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--olive);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.brand-name {
  font-size: 1rem;
}

.zero-mark {
  display: block;
  flex: none;
  color: var(--olive);
}

.status-pill {
  margin: 0;
  padding: 0.35rem 0.7rem;
  border: 1px solid rgba(28, 82, 158, 0.24);
  border-radius: 999px;
  color: var(--olive-deep);
  background: rgba(28, 82, 158, 0.08);
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 500;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

/* Keep the brand and non-wrapping readiness label from creating a fractional
   horizontal scroll range at the 320px reflow boundary. */
@media (max-width: 22.5rem) {
  .site-chrome { flex-wrap: wrap; }
  .status-pill { margin-left: auto; }
}

h1 {
  margin: 0 0 0.65rem;
  font-family: var(--font-serif);
  font-size: clamp(2rem, 8vw, 2.7rem);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
}

h2 {
  font-size: 1.05rem;
  font-weight: 600;
  line-height: 1.3;
  margin: 1.5rem 0 0.5rem;
}

h3 { font-size: 1rem; margin: 1rem 0 0.25rem; }

.kicker {
  margin: 1.25rem 0 0.35rem;
  color: var(--bone-dim);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.1em;
}

.loop {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0;
  row-gap: 0.45rem;
  margin: 1.25rem 0 0.25rem;
  padding: 0;
  list-style: none;
  color: var(--bone-dim);
  font-family: var(--font-mono);
  font-size: 0.58rem;
  letter-spacing: 0.07em;
}

.loop li {
  position: relative;
  display: flex;
  flex: none;
  align-items: flex-start;
  padding-top: 0.85rem;
}

.loop li::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 6px;
  height: 6px;
  border: 1px solid var(--bone);
  border-radius: 50%;
  background: transparent;
}

.loop li:not(:last-child) {
  padding-right: 0.85rem;
  margin-right: 0.1rem;
}

.loop li:not(:last-child)::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 6px;
  width: calc(100% - 6px);
  height: 1px;
  background: var(--bone);
}

/* 2.4.7 / 2.4.11 focus is always visible and never clipped. */
:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}

.action, .action-secondary {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: ${String(PRIMARY_TARGET_PX)}px;
  padding: 0.75rem 1rem;
  margin: 0.5rem 0;
  border-radius: 12px;
  font-family: var(--font-sans);
  font-size: 0.95rem;
  font-weight: 500;
  letter-spacing: 0;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  background: var(--surface);
  color: var(--olive);
}

.action {
  border: 1px solid var(--olive);
  color: #ffffff;
  background: var(--olive);
}

.action-secondary {
  border: 1px solid var(--line);
}

.action:hover { background: var(--olive-deep); }
.action-secondary:hover { background: rgba(28, 82, 158, 0.08); }

button.action,
button.action-secondary {
  appearance: none;
  font: inherit;
}

form {
  margin: 0;
}

.logout-form {
  margin-left: auto;
}

.logout-action {
  appearance: none;
  min-height: 44px;
  padding: 0.45rem 0.65rem;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  color: var(--danger);
  font-family: var(--font-sans);
  cursor: pointer;
}

.logout-action:hover {
  background: rgba(199, 38, 38, 0.08);
}

label {
  display: block;
  margin: 0.85rem 0 0.35rem;
  font-weight: 600;
}

input[type='text'],
input[type='email'],
input[type='tel'],
input[type='number'],
select {
  display: block;
  width: 100%;
  min-height: ${String(PRIMARY_TARGET_PX)}px;
  padding: 0.7rem 0.85rem;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  font: inherit;
  color: var(--bone);
  background: var(--plate);
}

select {
  appearance: auto;
}

.provider-grid {
  margin-top: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 22rem), 1fr));
}

.provider-card {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.provider-card-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
}

.provider-card-heading h3 {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.provider-card-heading .badge {
  flex: 0 0 auto;
}

.provider-form {
  margin-top: 0.35rem;
  padding-top: 0.35rem;
  border-top: 1px solid var(--line);
}

.provider-enable-form {
  margin: 1rem 0 1.25rem;
  padding: 0.9rem;
  border: 1px solid var(--line-strong);
  border-radius: 12px;
  background: var(--surface);
}

.field-note {
  margin: 0.45rem 0 0.75rem;
  color: var(--bone-dim);
  font-size: 0.85rem;
}

.help-tip {
  margin: 0.75rem 0;
  border-left: 2px solid var(--olive);
  padding-left: 0.65rem;
}

.help-tip summary {
  min-height: ${String(MIN_TARGET_PX)}px;
  padding: 0.2rem 0;
  color: var(--olive);
  cursor: pointer;
  font-weight: 600;
}

.help-tip p {
  margin: 0.35rem 0 0;
}

fieldset.check-in-options {
  margin: 0.75rem 0;
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
}

fieldset.check-in-options legend {
  padding: 0 0.35rem;
  font-weight: 600;
}

label.option {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-height: ${String(PRIMARY_TARGET_PX)}px;
  margin: 0.35rem 0;
  font-weight: 500;
  cursor: pointer;
}

input[type='radio'] {
  width: 1.25rem;
  height: 1.25rem;
  accent-color: var(--olive);
}

/* 2.5.8 target size floor for every remaining interactive element. */
a, button, input, [role="button"] {
  min-height: ${String(MIN_TARGET_PX)}px;
}

.card-grid {
  display: grid;
  /* The native HomeView uses one full-width service card per row. */
  grid-template-columns: 1fr;
  gap: 0.75rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.card {
  display: block;
  min-height: 5rem;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  color: var(--bone);
  text-decoration: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
}

.card-category-shelter { border-left: 5px solid var(--shelter); }
.card-category-food { border-left: 5px solid var(--food); }
.card-category-transportation { border-left: 5px solid var(--transportation); }

.card-unavailable { color: var(--bone-soft); }

/*
 * 1.4.1 use of color: every state carries a text label. The badge adds
 * emphasis, it does not carry the meaning on its own.
 */
.badge {
  display: inline-block;
  padding: 0.15rem 0.5rem;
  border: 1px solid var(--olive);
  border-radius: 1rem;
  color: var(--olive);
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.04em;
}

.state {
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-left: 3px solid var(--olive);
  border-radius: 12px;
  background: var(--surface);
}

.reserved-slot {
  padding: 0.75rem;
  border: 1px dashed var(--line-strong);
  border-radius: 12px;
  background: var(--surface);
  color: var(--bone-dim);
}

.crisis-card {
  margin-top: 1.5rem;
  padding: 1rem;
  border: 1px solid rgba(199, 38, 38, 0.18);
  border-radius: 16px;
  background: rgba(199, 38, 38, 0.06);
}

.crisis-card h2 { margin-top: 0; }

.mobile-nav {
  position: fixed;
  inset: auto 0 0 0;
  z-index: 10;
  display: flex;
  border-top: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.96);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.mobile-nav a {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: ${String(PRIMARY_TARGET_PX)}px;
  padding: 0.5rem;
  font-weight: 600;
  text-decoration: none;
  color: var(--bone-dim);
}

.mobile-nav a[aria-current='page'] {
  color: var(--olive);
  text-decoration: none;
  box-shadow: inset 0 -3px 0 var(--olive);
}

dl {
  margin: 0.5rem 0;
}

dt {
  font-weight: 600;
  margin-top: 0.75rem;
}

dd {
  margin: 0.15rem 0 0;
}

.muted { color: var(--bone-dim); }

.skip-link {
  position: absolute;
  left: 0.75rem;
  top: 0.75rem;
  z-index: 30;
  display: inline-flex;
  align-items: center;
  min-height: ${String(PRIMARY_TARGET_PX)}px;
  padding: 0.75rem 1rem;
  background: var(--olive);
  color: #ffffff;
  font-weight: 600;
  text-decoration: none;
  /* 2.4.1: hidden until keyboard focus. clip-path (not left:-9999px) so
     the control stays in-tab-order and :focus-visible can reveal it. */
  clip-path: inset(50%);
  clip: rect(0 0 0 0);
  overflow: hidden;
  white-space: nowrap;
}

.skip-link:focus,
.skip-link:focus-visible {
  clip: auto;
  clip-path: none;
  overflow: visible;
}

/* 2.3.3 animation from interactions. Nothing here animates, and this keeps it so. */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
`.trim();
