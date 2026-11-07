/**
 * The process environment class, read here so other modules do not touch `process`.
 *
 * SUAS-specs ENVIRONMENT.md §2: the class is `SUAS_ENV`, never inferred from NODE_ENV.
 */

import { ENVIRONMENT_CLASSES, type EnvironmentClass } from './schema.js';

export function trustedEnvironmentClass(
  source: { SUAS_ENV?: string | undefined } = process.env,
): EnvironmentClass | undefined {
  const value = source.SUAS_ENV?.trim();
  if (value === undefined || value === '') return undefined;
  return (ENVIRONMENT_CLASSES as readonly string[]).includes(value)
    ? (value as EnvironmentClass)
    : undefined;
}
