/**
 * R12.7 (OWNER DECISION, recommended option): the web keeps the crisis copy compiled in and
 * does not read GET /api/v0/immediate-resources. This test fails the build when the web's
 * crisis destinations or §1.1 entry text drift from the approved list in src/ui/safety.ts.
 * It reads the web sources as text, so it needs no browser and no React in the root package.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_CRISIS_DESTINATIONS,
  CRISIS_ENTRY_DANGER,
  CRISIS_ENTRY_HEADING,
  CRISIS_ENTRY_LIFELINE,
  CRISIS_ENTRY_NOT_EMERGENCY,
  PENDING_RELEASE_CRISIS_DESTINATIONS,
} from '../../src/ui/safety.js';

const WEB_SRC = resolve(import.meta.dirname, '../../web/src');
const CRISIS_FILES = [
  'components/CrisisStrip.tsx',
  'components/CrisisPanel.tsx',
  'components/Footer.tsx',
  'features/public/crisis-result.ts',
  'features/request/RequestStatusCard.tsx',
];

const read = (file: string) => readFileSync(join(WEB_SRC, file), 'utf8');

/** JSX source as reading text: tags dropped, entities decoded, whitespace collapsed. */
const asText = (source: string) =>
  source
    .replace(/\{\s*' '\s*\}/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,])/g, '$1');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'schema.d.ts'
      ? [path]
      : [];
  });
}

describe('web crisis copy matches src/ui/safety.ts (R12.7)', () => {
  it('uses only approved crisis destinations', () => {
    const approved = new Set<string>(APPROVED_CRISIS_DESTINATIONS);
    for (const file of CRISIS_FILES) {
      for (const destination of read(file).match(/\b(?:tel|sms):[^"'\s}]+/g) ?? []) {
        expect(approved.has(destination), `${file}: ${destination}`).toBe(true);
      }
    }
    expect(PENDING_RELEASE_CRISIS_DESTINATIONS).toEqual([]);
  });

  it('the crisis strip offers every approved destination', () => {
    const strip = read('components/CrisisStrip.tsx');
    for (const destination of APPROVED_CRISIS_DESTINATIONS) {
      expect(strip).toContain(`href="${destination}"`);
    }
  });

  it('the crisis panel carries the SAFETY_COPY.md §1.1 entry text verbatim', () => {
    const panel = asText(read('components/CrisisPanel.tsx'));
    for (const sentence of [
      CRISIS_ENTRY_HEADING,
      CRISIS_ENTRY_DANGER,
      CRISIS_ENTRY_NOT_EMERGENCY,
      CRISIS_ENTRY_LIFELINE,
    ]) {
      expect(panel).toContain(sentence);
    }
  });

  it('the web does not read GET /api/v0/immediate-resources', () => {
    for (const file of sourceFiles(WEB_SRC)) {
      expect(readFileSync(file, 'utf8'), file).not.toContain('/immediate-resources');
    }
  });
});
