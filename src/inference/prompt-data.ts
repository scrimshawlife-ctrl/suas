/**
 * Untrusted text placed inside prompt delimiters (intake, extraction, chat assistance) has its
 * angle brackets escaped, so no opening or closing tag, of any case, spacing or nesting, can be
 * forged from it. Deleting one exact tag string is not enough ("</mess</message>age>").
 */
export function escapePromptData(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
