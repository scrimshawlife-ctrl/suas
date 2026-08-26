/**
 * Public Pages legal-copy evidence.
 *
 * SUAS-specs COMPLIANCE.md §11 (UI string forbid: no "HIPAA compliant",
 * "CCPA compliant", or "TCPA compliant"); COMPLIANCE.md §1 (register, not a
 * certificate); CONSENT.md §6 (do not ship grants against unpublished
 * templates); PRIVACY.md §10 (D-007 durations stay DECISION_PENDING).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const PUBLIC_LEGAL_FILES = [
  'docs/index.html',
  'docs/privacy.html',
  'docs/legal.html',
  'docs/legal/privacy-notice.md',
  'docs/legal/terms.md',
  'docs/legal/consent-templates.md',
] as const;

const FORBIDDEN_COMPLIANCE_CLAIMS = [
  /hipaa[\s-]*compliant/i,
  /ccpa[\s-]*compliant/i,
  /cpra[\s-]*compliant/i,
  /tcpa[\s-]*compliant/i,
] as const;

const CLOSED_CONSENT_PAIRS = [
  'can_receive + YELLOW',
  'can_receive + ORANGE',
  'can_receive + RED',
  'can_view + support_signal',
  'can_view + checkin_answers',
  'can_view + current_requests',
  'can_view + location',
  'can_share + service_request_fulfillment',
] as const;

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${repoRoot}`), 'utf8');
}

describe('COMPLIANCE.md §11 — public legal copy forbids compliance claims', () => {
  it.each(PUBLIC_LEGAL_FILES)('%s contains none of the forbidden claim strings', (file) => {
    const text = readRepoFile(file);
    for (const pattern of FORBIDDEN_COMPLIANCE_CLAIMS) {
      expect(text, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  });
});

describe('Public Pages footer', () => {
  it('links Privacy and Legal from the site footer with relative hrefs', () => {
    const index = readRepoFile('docs/index.html');
    expect(index).toContain('href="privacy.html"');
    expect(index).toContain('href="legal.html"');
    expect(index).toContain('Draft notices, not a certification.');
  });

  it('keeps the same footer links on the privacy and legal pages', () => {
    for (const file of ['docs/privacy.html', 'docs/legal.html'] as const) {
      const page = readRepoFile(file);
      expect(page, file).toContain('href="privacy.html"');
      expect(page, file).toContain('href="legal.html"');
      expect(page, file).toContain('SPEC-017 · NOT READY');
      expect(page, file).toContain('Zero State LLC');
      expect(page, file).toContain('D-013');
    }
  });
});

describe('CONSENT.md §6 — draft templates stay unpublished', () => {
  it('marks every closed permission/scope pair DRAFT / unpublished', () => {
    const templates = readRepoFile('docs/legal/consent-templates.md');
    expect(templates).toMatch(/DRAFT \/ unpublished/i);
    for (const pair of CLOSED_CONSENT_PAIRS) {
      expect(templates, pair).toContain(pair);
      const headingIndex = templates.indexOf(`## ${pair}`);
      expect(headingIndex, pair).toBeGreaterThan(-1);
      const nextHeading = templates.indexOf('\n## ', headingIndex + 1);
      const section =
        nextHeading === -1
          ? templates.slice(headingIndex)
          : templates.slice(headingIndex, nextHeading);
      expect(section, pair).toMatch(/DRAFT \/ unpublished/i);
    }
  });

  it('does not wire the drafts into grant evaluation', () => {
    const moduleSource = readRepoFile('src/consent/templates.ts');
    expect(moduleSource).toMatch(/This module ships no template copy/);
    expect(moduleSource).not.toContain('consent-templates.md');
    expect(moduleSource).not.toContain('can_receive + YELLOW');
  });
});

describe('PRIVACY.md §10 — public notice does not invent retention durations', () => {
  it('states D-007 is open and does not name a day or month count', () => {
    for (const file of ['docs/privacy.html', 'docs/legal/privacy-notice.md'] as const) {
      const text = readRepoFile(file);
      expect(text, file).toMatch(/D-007/);
      expect(text, file).toMatch(/not decided/i);
      expect(text, file).not.toMatch(/\b\d+\s+(days?|months?|years?)\b/i);
    }
  });
});
