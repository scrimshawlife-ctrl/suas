/**
 * The sidebar scope line for the environment class build info reports. Only synthetic classes
 * get one; anything else (or an unreadable value) shows no line rather than a guess.
 */
export function adminScopeLine(environment: unknown): string | undefined {
  if (environment === 'STAGING') return 'Scope: Synthetic staging.';
  if (environment === 'LOCAL') return 'Scope: Local synthetic data.';
  return undefined;
}
