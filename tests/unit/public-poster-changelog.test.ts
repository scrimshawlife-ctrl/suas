/**
 * Pages poster changelog is a short product record, not a SHA/slice catalogue.
 *
 * PRODUCT.md / CONTEXT.md (not EHR / 911; not a launch);
 * SAFETY.md §3.2 (settled effective RED opens or updates a Support Case);
 * ENVIRONMENT.md (this tab is not live operations; production stays closed).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, `file://${repoRoot}`), 'utf8');
}

function changelogBlock(index: string): string {
  const start = index.indexOf('id="changelog-title"');
  const end = index.indexOf('class="site-footer"');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('Pages poster changelog', () => {
  const index = readRepoFile('docs/index.html');
  const changelog = changelogBlock(index);

  it('keeps the heading, one-line meta, formation off-list, and Not line', () => {
    expect(changelog).toContain('What left the formation.');
    expect(changelog).toMatch(/Spec 0\.2\.0\./);
    expect(changelog).toMatch(/zer0state/);
    expect(changelog).toMatch(/Not live/);
    expect(changelog).toMatch(/Production stays closed/);
    expect(changelog).toContain('STILL IN FORMATION');
    expect(changelog).toMatch(/rides and rooms/);
    expect(changelog).toMatch(/Food and peer APIs/);
    expect(changelog).toMatch(/invent a new vendor/);
    expect(changelog).toContain(
      'Not: EHR, diagnosis, suicide prediction, automated emergency dispatch, HIPAA claim.',
    );
  });

  it('records the product-true set without plating a SHA or slice parade', () => {
    expect(changelog).toContain('This walk.');
    expect(changelog).toContain('Check-In.');
    expect(changelog).toContain('Support case.');
    expect(changelog).toContain('Consent.');
    expect(changelog).toContain('Queue.');
    expect(changelog).toContain('Peer backup.');
    expect(changelog).toContain('On duty.');
    expect(changelog).toContain('Sends.');
    expect(changelog).toContain('Stage.');
    expect(changelog).not.toMatch(/Kernel slices on main/);
    expect(changelog).not.toMatch(/Slice \d+/);
    expect(changelog).not.toMatch(/class="hash"/);
    expect(changelog).not.toMatch(/slice-plate/);
    expect(changelog).not.toMatch(/OpenAPI/);
    expect(changelog).not.toMatch(/\bD-0\d{2}\b/);
    expect(changelog).not.toMatch(/Consent Grant, and QRF/);
    expect(changelog).not.toMatch(/transition/i);
  });

  it('does not claim the walk shows Consent or peer backup, or a live host', () => {
    expect(changelog).toMatch(/This walk\s+does not show them/);
    expect(changelog).toMatch(/They are not\s+in this walk/);
    expect(changelog).toMatch(/does not call a public host/);
    expect(changelog).toMatch(/Not\s+ready for a pilot/);
    expect(changelog).toMatch(/SUAS does not call 911/);
  });
});
