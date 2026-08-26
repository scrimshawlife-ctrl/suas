/**
 * Presentation-floor evidence.
 *
 * SUAS-specs MVP_REFERENCE.md §4 (large action targets, mobile first);
 * MVP_REFERENCE.md §10 (WCAG 2.2 AA 1.4.10 reflow, 2.4.1 skip link, 2.5.8
 * target size). Does not claim `UI_CONFORMANCE`.
 */

import { describe, expect, it } from 'vitest';
import {
  MIN_TARGET_PX,
  PAGES_BG,
  PAGES_BONE,
  PAGES_OLIVE,
  PRIMARY_TARGET_PX,
  STYLESHEET,
} from '../../src/ui/theme.js';
import { renderLanding } from '../../src/ui/surfaces.js';

describe('MVP_REFERENCE.md §10 — presentation floors', () => {
  it('keeps the WCAG 2.5.8 and §4.2 target sizes', () => {
    expect(MIN_TARGET_PX).toBe(24);
    expect(PRIMARY_TARGET_PX).toBe(48);
    expect(STYLESHEET).toContain(`min-height: ${String(PRIMARY_TARGET_PX)}px`);
  });

  it('does not force two 9rem columns at 320 CSS px', () => {
    const defaultGrid = /\.card-grid \{[\s\S]*?grid-template-columns: ([^;]+);/.exec(STYLESHEET);
    expect(defaultGrid?.[1]?.trim()).toBe('1fr');
    expect(STYLESHEET).toContain('@media (min-width: 22.5rem)');
    expect(STYLESHEET).toContain('repeat(auto-fit, minmax(9rem, 1fr))');
  });

  it('reveals the skip link on focus without parking it at -9999px', () => {
    expect(STYLESHEET).toContain('clip-path: inset(50%)');
    expect(STYLESHEET).not.toContain('left: -9999px');
    expect(STYLESHEET).toContain('.skip-link:focus-visible');
  });

  it('clears the home-indicator safe area so the last action stays reachable', () => {
    expect(STYLESHEET).toContain('env(safe-area-inset-bottom');
  });

  it('gives text inputs the primary 48px target and a visible label block', () => {
    expect(STYLESHEET).toContain("input[type='text']");
    expect(STYLESHEET).toContain(`min-height: ${String(PRIMARY_TARGET_PX)}px`);
    expect(STYLESHEET).toMatch(/label \{[\s\S]*display: block;/);
  });
});

describe('MVP_REFERENCE.md §10 — landing document still permits zoom', () => {
  it('keeps viewport-fit=cover without capping scale', () => {
    const html = renderLanding({
      shell: { title: 'Shut Up and Serve', viewport: 'MOBILE', showMobileNav: false },
      missionLine: 'Veteran peer support, coordinated by people who served.',
    });
    expect(html).toContain('viewport-fit=cover');
    expect(html).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(html).toContain('class="skip-link"');
  });
});

describe('Pages visual system — presentation tokens', () => {
  it('uses the shipped dark Pages palette, not the retired light theme', () => {
    expect(PAGES_BG).toBe('#0b0d0c');
    expect(PAGES_BONE).toBe('#e8e4d6');
    expect(PAGES_OLIVE).toBe('#9aaa5c');
    expect(STYLESHEET).toContain(`--bg: ${PAGES_BG}`);
    expect(STYLESHEET).toContain(`--bone: ${PAGES_BONE}`);
    expect(STYLESHEET).toContain('color-scheme: dark');
    expect(STYLESHEET).toContain('border-radius: 3px');
    expect(STYLESHEET).not.toContain('#14425f');
    expect(STYLESHEET).not.toContain('#b4530a');
    expect(STYLESHEET).not.toContain('color-scheme: light');
  });

  it('keeps focus visible on dark and does not use bone-mute for body text', () => {
    expect(STYLESHEET).toContain('outline: 3px solid var(--focus)');
    expect(STYLESHEET).toContain('--focus: #e8e4d6');
    expect(STYLESHEET).toContain('.muted { color: var(--bone-dim); }');
    expect(STYLESHEET).not.toContain('--bone-mute');
  });

  it('keeps required landing actions after shell chrome', () => {
    const html = renderLanding({
      shell: { title: 'Shut Up and Serve', viewport: 'MOBILE', showMobileNav: false },
      missionLine: 'Veteran peer support, coordinated by people who served.',
    });
    expect(html).toContain('class="zero-mark"');
    expect(html).toContain('SPEC-017 · NOT READY');
    expect(html).toContain('I NEED SUPPORT');
    expect(html).toContain('I WANT TO SERVE');
    expect(html).toContain('TAKE ACTION');
    expect(html).toContain('class="loop"');
    for (const step of [
      'SIGNAL',
      'NEED',
      'CONSENT',
      'COORDINATION',
      'FULFILLMENT',
      'FOLLOW-UP',
      'SETTLEMENT',
    ]) {
      expect(html, step).toContain(`<li>${step}</li>`);
    }
    expect(html).not.toContain('CHECK-IN');
  });
});
