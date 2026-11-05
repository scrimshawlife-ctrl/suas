import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INCOMPLETE_TEXT, NOT_A_DIAGNOSIS, resultCopy } from './check-in-result';

/** The repo's forbidden crisis phrases, read from the source so the lists cannot drift. */
function forbiddenPhrases(): string[] {
  const source = readFileSync(resolve(process.cwd(), '../src/ui/truthfulness.ts'), 'utf8');
  const block = /FORBIDDEN_CRISIS_PHRASES = \[([\s\S]*?)\] as const/.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

const LEVELS = [null, 'GREEN', 'YELLOW', 'ORANGE', 'RED'] as const;

function copyFor(level: (typeof LEVELS)[number]) {
  return resultCopy({
    support_signal: level === null ? null : { support_signal_id: 's1', level },
  });
}

describe('Check-In result copy', () => {
  it('finds the forbidden phrase list (guards the parser above)', () => {
    expect(forbiddenPhrases()).toContain('Help is on the way');
    expect(forbiddenPhrases().length).toBeGreaterThanOrEqual(8);
  });

  it('is the same two neutral lines for every level; only RED adds the crisis panel', () => {
    for (const level of LEVELS) {
      const copy = copyFor(level);
      expect(copy.heading).toBe('Thank you for checking in.');
      expect(copy.body).toBe('Your answers are saved.');
      expect(copy.crisis).toBe(level === 'RED');
    }
  });

  it('has no forbidden crisis phrase and no claim about the person', () => {
    const claim =
      /suggest|point(s)? to|harder|nothing in|right away|you (are|feel|may|could|need)|alert|trusted contact|score|green|yellow|orange|red\b/i;
    const strings = [
      ...LEVELS.flatMap((level) => [copyFor(level).heading, copyFor(level).body]),
      NOT_A_DIAGNOSIS,
      INCOMPLETE_TEXT,
    ];
    for (const text of strings) {
      for (const phrase of forbiddenPhrases()) {
        expect(text.toLowerCase(), text).not.toContain(phrase.toLowerCase());
      }
      expect(text, text).not.toMatch(claim);
    }
    expect(NOT_A_DIAGNOSIS).toBe(
      'This is not a diagnosis and does not contact emergency services.',
    );
  });
});
