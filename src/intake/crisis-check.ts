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
 * Cyrillic, Greek and Latin letters drawn like plain Latin ones, so "suісіdе", "ЅUICIDE", "suıcide"
 * and "ꜱᴜɪᴄɪᴅᴇ" cannot slip past. R17.x (contributor's call, D-064). Pairs of glyph and letter, so
 * the two never fall out of line; capitals map straight to the lower-case Latin letter.
 */
const LOOK_ALIKE_PAIRS: readonly (readonly [string, string])[] = [
  // Cyrillic small
  ...pairs('аеорсухіѕјԁԛԝӏһԍ', 'aeopcyxisjdqwlhg'),
  // Cyrillic capital
  ...pairs('АВЕЅІЈКМНОРСТУХҺԀԚԜӀԌ', 'abesijkmhopctyxhdqwlg'),
  // Greek
  ...pairs('οΑΒΕΖΗΙΚΜΝΟΡΤΥΧ', 'oabezhikmnoptyx'),
  // Latin dotless i and small capitals
  ...pairs('ıᴀʙᴄᴅᴇɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ', 'iabcdeghijklmnoprstuvwyz'),
];
function pairs(glyphs: string, letters: string): (readonly [string, string])[] {
  const from = [...glyphs];
  if (from.length !== letters.length) throw new Error('look-alike table out of line');
  return from.map((glyph, index) => [glyph, letters[index]!] as const);
}
const LOOK_ALIKE = new Map(LOOK_ALIKE_PAIRS);
const LOOK_ALIKE_PATTERN = new RegExp(
  `[${LOOK_ALIKE_PAIRS.map(([glyph]) => glyph).join('')}]`,
  'g',
);

/**
 * Enclosed letters NFKC does not turn into plain ones: parenthesized ⒜–⒵ (U+249C) and 🄐–🄩
 * (U+1F110), which it would make "(s)", and negative circled 🅐–🅩 (U+1F150) and negative squared
 * 🅰–🆉 (U+1F170), which it leaves alone. Each block of 26 maps to a–z by position.
 */
const ENCLOSED_BLOCKS = [0x249c, 0x1f110, 0x1f150, 0x1f170] as const;
const ENCLOSED_LETTER =
  /[\u{249C}-\u{24B5}\u{1F110}-\u{1F129}\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}]/gu;
const unenclose = (glyph: string): string => {
  const point = glyph.codePointAt(0) ?? 0;
  const start = ENCLOSED_BLOCKS.find((block) => point >= block && point < block + 26) ?? point;
  return String.fromCodePoint(0x61 + point - start);
};

/**
 * Typed letters in parentheses, "(s)" or "(su)" (full-width too, after NFKC), up to 20 so the
 * pattern stays linear; unwrapped only in its own variant below (review 2026-11-24).
 */
const TYPED_PARENTHESIZED_LETTERS = /\((\p{L}{1,20})\)/gu;

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

const mapLookAlikes = (text: string): string =>
  text.replace(LOOK_ALIKE_PATTERN, (glyph) => LOOK_ALIKE.get(glyph) ?? glyph);

/** The plain normalization after enclosed letters and homoglyphs become Latin letters. */
function letterMappedNormalize(text: string): string {
  return plainNormalize(mapLookAlikes(text.replace(ENCLOSED_LETTER, unenclose).normalize('NFKC')));
}

/** Like the letter-mapped variant, but typed "(su)" reads "su": "(su)icide", "sui(c)ide". */
function parenUnwrappedNormalize(text: string): string {
  return plainNormalize(
    mapLookAlikes(text.normalize('NFKC').replace(TYPED_PARENTHESIZED_LETTERS, '$1')),
  );
}

const NORMALIZED_PHRASES = [...new Set(CRISIS_PHRASES.map(plainNormalize))];
const VARIANTS = [plainNormalize, letterMappedNormalize, parenUnwrappedNormalize] as const;

/**
 * True when the text contains any crisis phrase on word boundaries in any of the three
 * normalizations. Each variant can only add matches, never hide one another variant shows.
 */
export function detectCrisisLanguage(text: string): boolean {
  return VARIANTS.some((normalize) => {
    const padded = ` ${normalize(text)} `;
    return NORMALIZED_PHRASES.some((phrase) => padded.includes(` ${phrase} `));
  });
}
