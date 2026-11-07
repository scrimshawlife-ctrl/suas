/**
 * Compare a Node version with a declared `>=major.minor.patch` engine.
 * The packages in this repository use that form so an unsupported 22.0 fails
 * before a dependency's own engine error.
 */

export function nodeEngineIssue(version: string, range: string): string | undefined {
  const required = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(range);
  const current = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (required === null || current === null) {
    return `Unrecognized Node engine check (version "${version}", range "${range}").`;
  }
  const got = [Number(current[1]), Number(current[2]), Number(current[3])];
  const need = [Number(required[1]), Number(required[2]), Number(required[3])];
  for (let index = 0; index < 3; index += 1) {
    const left = got[index] ?? 0;
    const right = need[index] ?? 0;
    if (left > right) return undefined;
    if (left < right) {
      return `Node ${version} is not supported. This package requires Node ${range}.`;
    }
  }
  return undefined;
}
