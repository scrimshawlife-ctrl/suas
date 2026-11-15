/** Types for scripts/synth-deploy.mjs. The script stays JavaScript so `node` can run it. */

export function deploySynthPlan(
  parent: Readonly<Record<string, string | undefined>>,
  webIndex?: string,
): { readonly env: Record<string, string | undefined>; readonly args: string[] };
