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

/**
 * Parenthesized letters ⒜–⒵ (U+249C–U+24B5) and 🄐–🄩 (U+1F110–U+1F129). NFKC would turn them
 * into "(s)", so they map to plain letters first; an ASCII "(d)" typed after a word is left alone.
 */
const PARENTHESIZED_LETTER = /[\u{249C}-\u{24B5}\u{1F110}-\u{1F129}]/gu;
const unparenthesize = (glyph: string): string => {
  const point = glyph.codePointAt(0) ?? 0;
  return String.fromCodePoint(0x61 + point - (point < 0x1f110 ? 0x249c : 0x1f110));
};

/**
 * R17.x (contributor's call, D-064): NFKC (full-width, circled and compatibility forms), drop
 * invisible characters, lower-case, drop apostrophes ("can't" reads "cant"), turn other
 * punctuation into spaces ("self-harm" reads "self harm"), then collapse whitespace.
 */
function plainNormalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The plain normalization after parenthesized letters and homoglyphs become Latin letters. */
function letterMappedNormalize(text: string): string {
  return plainNormalize(
    text
      .replace(PARENTHESIZED_LETTER, unparenthesize)
      .normalize('NFKC')
      .replace(LOOK_ALIKE_PATTERN, (glyph) => LATIN_FORMS[LOOK_ALIKES.indexOf(glyph)] ?? glyph),
  );
}

const NORMALIZED_PHRASES = [...new Set(CRISIS_PHRASES.map(plainNormalize))];

/**
 * True when the text contains any crisis phrase on word boundaries, in either normalization: a
 * letter mapping can only add matches, never hide one the plain text already shows.
 */
export function detectCrisisLanguage(text: string): boolean {
  return [plainNormalize(text), letterMappedNormalize(text)].some((normalized) => {
    const padded = ` ${normalized} `;
    return NORMALIZED_PHRASES.some((phrase) => padded.includes(` ${phrase} `));
  });
}
