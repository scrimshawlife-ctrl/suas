/**
 * Presentation-floor evidence.
 *
 * SUAS-specs MVP_REFERENCE.md §4 (large action targets, mobile first);
 * MVP_REFERENCE.md §10 (WCAG 2.2 AA 1.4.10 reflow, 2.4.1 skip link, 2.5.8
 * target size). Does not claim `UI_CONFORMANCE`.
 */

import { describe, expect, it } from 'vitest';
import { MIN_TARGET_PX, PRIMARY_TARGET_PX, STYLESHEET } from '../../src/ui/theme.js';
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
