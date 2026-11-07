/** Types for scripts/synth.mjs. The script stays JavaScript so `node` can run it. */

export function offlineSynthEnv(
  parent: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined>;

export function localCdkBin(root?: string): string;

export function prepareCdkLaunch(root?: string): {
  readonly status: 0 | 1;
  readonly command: readonly [string, string] | null;
};

export function cdkSynthArgs(extra: readonly string[]): string[];
