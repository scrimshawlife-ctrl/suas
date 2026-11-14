/**
 * Drops repeats by key, keeping the first copy (r247 F1). Paged lists re-read every loaded page
 * from the first, so a row that moved across a page boundary between reads can arrive twice;
 * the first page is the freshest, so its copy wins. React keys stay unique too.
 */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
