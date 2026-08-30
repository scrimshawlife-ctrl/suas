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
 * Colors, type, radii, and surface hierarchy mirror the shipped iOS operator
 * reference (`docs/ios-operator.css` and `/suas/ios-operator.html`).
 * palette. Accessibility floors stay WCAG 2.2 AA values: 24x24 CSS px minimum
 * target size (2.5.8), visible focus (2.4.7, 2.4.11), reflow at 320 CSS px
 * (1.4.10), and text spacing tolerance (1.4.12).
 *
 * Contrast: ink `#101828` on white is 17.70:1; muted `#667085` on white is
 * 4.78:1; service blue `#1c529e` on white is 7.64:1.
 */

/**
 * Minimum target size in CSS pixels. WCAG 2.2 AA 2.5.8 sets 24; the reference's
 * "large action targets" (§4.2) and mobile-first critical paths (§4.7) justify
 * the larger floor on primary actions.
 */
export const MIN_TARGET_PX = 24;
export const PRIMARY_TARGET_PX = 48;

/** Canonical tokens from `docs/ios-operator.css`. */
export const IOS_GROUPED_BG = '#f2f4f7';
export const IOS_CARD = '#ffffff';
export const IOS_INK = '#101828';
export const IOS_MUTED = '#667085';
export const IOS_SERVICE_BLUE = '#1c529e';
export const IOS_SERVICE_BLUE_DARK = '#12325f';
export const IOS_TRANSPORTATION = '#2173b8';
export const IOS_FOOD = '#cc731a';
export const IOS_SHELTER = '#40804d';

export const STYLESHEET = `
:root {
  --bg: ${IOS_GROUPED_BG};
  --surface: ${IOS_CARD};
  --bone: ${IOS_INK};
  --bone-soft: #344054;
  --bone-dim: ${IOS_MUTED};
  --olive: ${IOS_SERVICE_BLUE};
  --olive-deep: ${IOS_SERVICE_BLUE_DARK};
  --transportation: ${IOS_TRANSPORTATION};
  --food: ${IOS_FOOD};
  --shelter: ${IOS_SHELTER};
  --danger: #c72626;
  --line: #d8dee8;
  --line-strong: #98a2b3;
  --plate: ${IOS_CARD};
  --focus: #7eb8ff;
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
  --font-serif: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'Cascadia Mono', 'SFMono-Regular', Consolas, monospace;
  color-scheme: light;
}

*, *::before, *::after { box-sizing: border-box; }

html { color-scheme: light; background: #f8fafc; }

body {
  margin: 0;
  /* Relative units so text zoom and reflow (1.4.10, 1.4.4) work. */
  font: 1rem/1.5 var(--font-sans);
  color: var(--bone);
  min-width: 320px;
  background: radial-gradient(circle at 78% 10%, rgba(33, 115, 184, 0.12), transparent 28rem), #f8fafc;
}

/* 1.4.12 text spacing: never clip on user-adjusted spacing. */
p, li, dd { overflow-wrap: break-word; }

.shell {
  position: relative;
  max-width: 42rem;
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
  padding: 0.85rem 1rem;
  border-bottom: 1px solid rgba(16, 24, 40, 0.09);
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--olive-deep);
  font-weight: 800;
  letter-spacing: 0.11em;
}

.brand-name {
  font-size: 1rem;
}

.zero-mark {
  display: grid;
  flex: none;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 10px;
  color: #ffffff;
  background: var(--olive);
  font-family: var(--font-sans);
  font-weight: 800;
  letter-spacing: 0;
}

.status-pill {
  margin: 0;
  padding: 0.35rem 0.7rem;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  color: var(--olive-deep);
  background: var(--surface);
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
  color: var(--olive-deep);
  font-size: clamp(2.35rem, 8vw, 3.6rem);
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: -0.03em;
}

h2 {
  font-size: 1.05rem;
  font-weight: 500;
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
  box-shadow: 0 10px 26px rgba(28, 82, 158, 0.24);
}

.action-secondary {
  border: 1px solid var(--line);
}

.action:hover { background: #164984; }
.action-secondary:hover { background: #e9f1fb; }

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
  background: #fceaea;
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
  border-radius: 16px;
  background: var(--plate);
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
  border-radius: 16px;
  background: var(--plate);
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
  /* Mobile-first: one column so 320 CSS px never grows a second 9rem track
     (1.4.10). Two columns only when 9rem + gap + 9rem fits the shell. */
  grid-template-columns: 1fr;
  gap: 0.75rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

@media (min-width: 22.5rem) {
  .card-grid {
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  }
}

.card {
  display: block;
  min-height: 5rem;
  padding: 1rem;
  border: 0;
  border-radius: 16px;
  background: var(--surface);
  color: var(--bone);
  text-decoration: none;
  box-shadow: 0 3px 10px rgba(16, 24, 40, 0.06);
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
  border-radius: 16px;
  background: var(--surface);
}

.reserved-slot {
  padding: 0.75rem;
  border: 1px dashed var(--line-strong);
  border-radius: 12px;
  background: var(--plate);
  color: var(--bone-dim);
}

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
  color: var(--bone-dim);
  font-weight: 600;
  text-decoration: none;
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
  background: var(--olive-deep);
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
