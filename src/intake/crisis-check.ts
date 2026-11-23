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

/** Zero-width and format characters (soft hyphen, LRM/RLM) and bidi embeddings and isolates. */
const INVISIBLE = /[\u200B-\u200F\u2060\uFEFF\u00AD\u202A-\u202E\u2066-\u2069]/g;

/**
 * Cyrillic, Greek and Latin letters drawn like plain Latin ones, so "suісіdе", "suıcide" and
 * "ꜱᴜɪᴄɪᴅᴇ" cannot slip past. R17.x (contributor's call, D-064): Cyrillic ѕјԁԛԝӏһԍ, dotless ı and
 * the Latin small capitals were added. Each glyph lines up with its letter in LATIN_FORMS.
 */
const LOOK_ALIKES = 'аеорсухіАЕОРСУХІοΟѕјԁԛԝӏһԍıᴀʙᴄᴅᴇɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ';
const LATIN_FORMS = 'aeopcyxiaeopcyxioosjdqwlhgiabcdeghijklmnoprstuvwyz';
const LOOK_ALIKE_PATTERN = new RegExp(`[${LOOK_ALIKES}]`, 'g');

/** NFKC turns "⒮" into "(s)"; a single letter in parentheses keeps just the letter. */
const PARENTHESIZED_LETTER = /\((\p{L})\)/gu;

/**
 * R17.x (contributor's call, D-064): NFKC (full-width, circled and compatibility forms), drop
 * invisible characters, unwrap "(s)", map homoglyphs, lower-case, drop apostrophes ("can't" reads "cant"), turn other
 * punctuation into spaces ("self-harm" reads "self harm"), then collapse whitespace.
 */
function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(PARENTHESIZED_LETTER, '$1')
    .replace(LOOK_ALIKE_PATTERN, (glyph) => LATIN_FORMS[LOOK_ALIKES.indexOf(glyph)] ?? glyph)
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
