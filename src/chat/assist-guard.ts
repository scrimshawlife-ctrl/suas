/**
 * R18.6 (contributor's call, D-066): a backstop output guard for chat assistance and its eval; the
 * helper still reviews every suggestion. Known limits: number words ("two o'clock") and digit-free
 * street names pass. The eval's raw_* metrics measure how often the model itself breaks the rules.
 */

import type { ChatAssistKind } from './assist.js';

const INVISIBLE = /[\u200B-\u200F\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/g;
const APOSTROPHES = /[\u2019\u2018\u02BC\uFF07`\u00B4]/g;

/** The decimal value of a Unicode digit: its distance from the start of its run of digits. */
function asciiDigit(digit: string): string {
  let codePoint = digit.codePointAt(0) ?? 0;
  let steps = 0;
  while (/\p{Nd}/u.test(String.fromCodePoint(codePoint - 1))) {
    codePoint -= 1;
    steps += 1;
  }
  return String(steps % 10);
}

/** NFKC, ASCII digits, one apostrophe, no invisible marks, single spaces, lower case. */
function normalizeGuardText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/\p{Nd}/gu, (digit) => (/[0-9]/.test(digit) ? digit : asciiDigit(digit)))
    .replace(APOSTROPHES, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Each fact shape with the canonical form two spellings of one fact share. */
const FACT_SHAPES: readonly { readonly pattern: RegExp; readonly canon: (s: string) => string }[] =
  [
    { pattern: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, canon: (s) => s },
    { pattern: /\b(?:https?:\/\/|www\.)\S+/g, canon: (s) => s.replace(/[.,;:!?)\]]+$/, '') },
    { pattern: /\d+ \w+ (?:st|street|ave|avenue|rd|road)\b/g, canon: (s) => s },
    { pattern: /\b\d{1,2}(?::\d{2})? ?(?:am|pm)\b/g, canon: (s) => s.replace(/ /g, '') },
    { pattern: /\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/g, canon: (s) => s.replace(/\D/g, '') },
    { pattern: /\$\d[\d,]*(?:\.\d{2})?/g, canon: (s) => s.replace(/,/g, '') },
    { pattern: /\d+/g, canon: (s) => s },
  ];

function factTokens(text: string): string[] {
  const plain = normalizeGuardText(text);
  return FACT_SHAPES.flatMap(({ pattern, canon }) => (plain.match(pattern) ?? []).map(canon));
}

/** True when `output` holds a fact-shaped token that is not exactly one in `source`. */
export function inventsFact(output: string, source: string): boolean {
  const known = new Set(factTokens(source));
  return factTokens(output).some((fact) => !known.has(fact));
}

const PROMISE =
  /\b(?:i\s+will|i'll|i\s+shall|i'm\s+going\s+to|i\s+am\s+going\s+to|i\s+promise|we\s+will|we'll|i\s+can\s+(?:pick|drive|bring|meet|come|get|take))\b/;

/** Normalized sentences; a line break also ends one, since each message is its own line. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalizeGuardText)
    .filter((sentence) => sentence !== '');
}

const words = (sentence: string): Set<string> => new Set(sentence.match(/[\p{L}\p{N}']+/gu));

/** Shared words over the larger word count, so a short helper promise cannot cover a long one. */
function overlap(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.max(left.size, right.size, 1);
}

/**
 * True when a sentence of `output` makes a promise that no helper sentence already makes: the
 * same whole sentence once normalized, or one sharing at least 80% of its words. Whole sentences
 * on both sides, so a trailing commitment, a changed time or a conditional is never waved through.
 */
export function makesNewPromise(output: string, helperText: string): boolean {
  const said = sentences(helperText);
  return sentences(output)
    .filter((sentence) => PROMISE.test(sentence))
    .some((promise) => !said.some((helper) => sameCommitment(promise, helper)));
}

/** At least 80% shared words, and every time, number or address in the promise is the helper's. */
function sameCommitment(promise: string, helper: string): boolean {
  if (overlap(promise, helper) < 0.8) return false;
  const helperFacts = new Set(factTokens(helper));
  return factTokens(promise).every((fact) => helperFacts.has(fact));
}

/** What the guard caught; never sent to the client, only read by the eval (R18.6). */
export interface AssistGuardReport {
  readonly blockedPromise: boolean;
  readonly blockedFact: boolean;
  readonly droppedSentences: number;
}

/**
 * A suggested reply that trips either check is dropped whole (text ''); a catch-up loses only the
 * sentences that do, and is '' when none are left.
 */
export function guardAssistText(
  kind: ChatAssistKind,
  text: string,
  input: { readonly source: string; readonly helperText: string },
): AssistGuardReport & { readonly text: string } {
  const parts = kind === 'SUGGEST_REPLY' ? [text] : text.split(/(?<=[.!?])\s+/);
  let blockedPromise = false;
  let blockedFact = false;
  const kept = parts.filter((part) => {
    const promise = makesNewPromise(part, input.helperText);
    const fact = inventsFact(part, input.source);
    blockedPromise ||= promise;
    blockedFact ||= fact;
    return !promise && !fact;
  });
  const droppedSentences = kind === 'CATCH_UP' ? parts.length - kept.length : 0;
  return { text: kept.join(' ').trim(), blockedPromise, blockedFact, droppedSentences };
}
