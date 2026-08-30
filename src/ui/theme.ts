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
 * Colors and type are the shipped Pages visual system
 * (`docs/styles.css`, https://scrimshawlife-ctrl.github.io/suas/), not a third
 * palette. Accessibility floors stay WCAG 2.2 AA values: 24x24 CSS px minimum
 * target size (2.5.8), visible focus (2.4.7, 2.4.11), reflow at 320 CSS px
 * (1.4.10), and text spacing tolerance (1.4.12).
 *
 * Contrast on `#0b0d0c`: bone `#e8e4d6` is 15.32:1; bone-dim `#9a9588` is
 * 6.53:1; olive `#9aaa5c` is 7.69:1 and may label or border. Bone-mute
 * `#6e6a60` is 3.61:1 and is not used for body text.
 */

/**
 * Minimum target size in CSS pixels. WCAG 2.2 AA 2.5.8 sets 24; the reference's
 * "large action targets" (§4.2) and mobile-first critical paths (§4.7) justify
 * the larger floor on primary actions.
 */
export const MIN_TARGET_PX = 24;
export const PRIMARY_TARGET_PX = 48;

/** Pages tokens, observed from `docs/styles.css`. */
export const PAGES_BG = '#0b0d0c';
export const PAGES_BONE = '#e8e4d6';
export const PAGES_OLIVE = '#9aaa5c';

/**
 * Subtle topographic overlay. Decorative only: non-interactive, low-opacity,
 * and ignored by assistive technology because it is a CSS background.
 */
const TOPO_SVG = encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice"><g fill="none" stroke="#4a5348" stroke-width="0.7"><path d="M-40 140C80 90 170 190 290 140s210-90 330-30 220 140 360 70 250-90 390-20 220 80 310 40"/><path d="M-20 220C90 180 190 280 310 230s200-70 320-10 210 120 350 60 240-70 370 10 200 70 290 30"/><path d="M-50 310C70 270 180 360 300 310s190-60 310 10 200 110 340 50 230-60 360 20 210 80 300 35"/><path d="M-30 400C100 360 210 450 330 400s180-50 300 20 190 100 330 45 220-50 350 25 200 70 290 40"/><ellipse cx="1080" cy="280" rx="160" ry="90"/><ellipse cx="240" cy="620" rx="130" ry="70"/></g></svg>',
);

export const STYLESHEET = `
:root {
  --bg: ${PAGES_BG};
  --bone: ${PAGES_BONE};
  --bone-soft: #c9c3b2;
  --bone-dim: #9a9588;
  --olive: ${PAGES_OLIVE};
  --olive-deep: #7a8644;
  --line: rgba(232, 228, 214, 0.3);
  --line-strong: rgba(232, 228, 214, 0.5);
  --plate: rgba(232, 228, 214, 0.03);
  --focus: ${PAGES_BONE};
  --font-sans: 'Segoe UI', system-ui, sans-serif;
  --font-serif: Georgia, 'Times New Roman', serif;
  --font-mono: ui-monospace, 'Cascadia Mono', 'SFMono-Regular', Consolas, monospace;
  color-scheme: dark;
}

*, *::before, *::after { box-sizing: border-box; }

html { color-scheme: dark; }

body {
  margin: 0;
  /* Relative units so text zoom and reflow (1.4.10, 1.4.4) work. */
  font: 1rem/1.5 var(--font-sans);
  color: var(--bone);
  background: var(--bg);
  isolation: isolate;
}

/* Decorative topo only. pointer-events: none so it cannot steal hits. */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: 0.18;
  background-image: url("data:image/svg+xml,${TOPO_SVG}");
  background-size: 90rem 56rem;
}

/* 1.4.12 text spacing: never clip on user-adjusted spacing. */
p, li, dd { overflow-wrap: break-word; }

.shell {
  position: relative;
  max-width: 34rem;
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
  margin: 0 0 1.75rem;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.55rem;
  color: var(--bone);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.brand-name {
  font-size: 1rem;
}

.zero-mark {
  display: block;
  flex: none;
  color: var(--bone);
}

.status-pill {
  margin: 0;
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--bone);
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
  font-size: clamp(2rem, 8vw, 3.1rem);
  font-weight: 700;
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

/* 2.4.7 / 2.4.11 focus is always visible and never clipped. Bone on #0b0d0c. */
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
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: 0.95rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-align: center;
  text-decoration: none;
  cursor: pointer;
  background: transparent;
  color: var(--bone);
}

.action {
  border: 1px solid var(--line-strong);
}

.action-secondary {
  border: 1px solid var(--line);
}

.action:hover, .action-secondary:hover {
  background: rgba(232, 228, 214, 0.06);
}

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
  border-radius: 3px;
  background: transparent;
  color: var(--bone);
  font-family: var(--font-mono);
  cursor: pointer;
}

.logout-action:hover {
  background: rgba(232, 228, 214, 0.06);
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
  border-radius: 3px;
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
  border-radius: 3px;
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
  border-radius: 3px;
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
  padding: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 3px;
  background: var(--plate);
  color: var(--bone);
  text-decoration: none;
}

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
  border-radius: 3px;
  background: var(--plate);
}

.reserved-slot {
  padding: 0.75rem;
  border: 1px dashed var(--line-strong);
  border-radius: 3px;
  background: var(--plate);
  color: var(--bone-dim);
}

.mobile-nav {
  position: fixed;
  inset: auto 0 0 0;
  z-index: 10;
  display: flex;
  border-top: 1px solid var(--line);
  background: var(--bg);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

.mobile-nav a {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: ${String(PRIMARY_TARGET_PX)}px;
  padding: 0.5rem;
  color: var(--bone);
  font-weight: 600;
  text-decoration: none;
}

.mobile-nav a[aria-current='page'] {
  text-decoration: underline;
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
  background: var(--bone);
  color: var(--bg);
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
