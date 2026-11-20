/**
 * Deterministic crisis-language check, run before any model call (R17.4, contributor proposal,
 * not released). A match skips the model and the caller shows the released D-012 crisis copy.
 * It routes to resources; it does not diagnose, score or predict anything (SAFETY.md §2), and
 * the crisis panel stays reachable either way.
 */

/**
 * R17.4 (contributor proposal, not released): the contributor's approved list (2026-11-20, under
 * the owner's delegation on SUAS-specs #115). Matched as whole words after normalizing.
 */
export const CRISIS_PHRASES: readonly string[] = [
  'kill myself',
  'killing myself',
  'suicide',
  'suicidal',
  'end my life',
  'ending my life',
  'take my life',
  'want to die',
  'wanna die',
  'better off dead',
  'hurt myself',
  'harm myself',
  'self harm',
  'overdose',
  'no reason to live',
  "can't go on",
  'cant go on',
  'unalive',
  'unaliving',
  'unalived',
  'sewerslide',
  'end it all',
  'ending it all',
  'off myself',
  'offing myself',
  'not worth living',
  "don't want to be here",
  "don't want to live",
  'kill me',
];

/**
 * Lower-case, drop apostrophes (so "can't" reads "cant"), turn other punctuation into spaces
 * (so "self-harm" reads "self harm"), then collapse whitespace.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const NORMALIZED_PHRASES = [...new Set(CRISIS_PHRASES.map(normalize))];

/** True when the text contains any crisis phrase on word boundaries. */
export function detectCrisisLanguage(text: string): boolean {
  const padded = ` ${normalize(text)} `;
  return NORMALIZED_PHRASES.some((phrase) => padded.includes(` ${phrase} `));
}
