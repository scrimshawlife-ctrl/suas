/**
 * Synthetic-STAGING evidence campaign safety guard.
 *
 * This verifies the committed, non-secret Worker configuration and records the
 * campaign's immutable authority boundary. It has no network, database, job,
 * provider, export, or deletion effect. A passing result is not proof that a
 * particular deployed Worker has the same bindings.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertSyntheticStagingContract,
  syntheticStagingContractErrors,
} from './check-synthetic-staging-contract.js';

export const SYNTHETIC_STAGING_CAMPAIGN_AUTHORITY = {
  D007_DELETION_EXECUTION: 'disabled',
  D007_EXPORT_DELIVERY: 'disabled',
  D007_365_DAY_PURGE: 'disabled',
  D025_REPORTING: 'disabled',
  REAL_WORLD_EFFECTS: 'disabled',
  PILOT_LAUNCH: 'blocked',
  PRODUCTION_LAUNCH: 'blocked',
} as const;

export type SyntheticStagingCampaignAuthority = typeof SYNTHETIC_STAGING_CAMPAIGN_AUTHORITY;

function readWranglerVars(configPath: string): Record<string, string | undefined> {
  const source = readFileSync(configPath, 'utf8');
  return Object.fromEntries(
    [...source.matchAll(/"([A-Z][A-Z0-9_]*)"\s*:\s*"([^"]*)"/g)].map((match) => [
      match[1]!,
      match[2],
    ]),
  );
}

export function syntheticStagingEvidenceInvariantErrors(
  values: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const errors = [...syntheticStagingContractErrors(values)];
  if (values.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS !== 'false') {
    errors.push('REAL_WORLD_EFFECTS must remain disabled.');
  }
  if (values.SUAS_SENSITIVE_AGGREGATE_REPORTING !== 'disabled') {
    errors.push('D025_REPORTING must remain disabled.');
  }
  return errors;
}

export function assertSyntheticStagingEvidenceInvariants(
  values: Readonly<Record<string, string | undefined>>,
): void {
  assertSyntheticStagingContract(values);
  const errors = syntheticStagingEvidenceInvariantErrors(values);
  if (errors.length > 0) {
    throw new Error(`Synthetic STAGING evidence invariants failed:\n- ${errors.join('\n- ')}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = resolve(process.cwd(), process.argv[2] ?? 'wrangler.jsonc');
  const values = readWranglerVars(configPath);
  assertSyntheticStagingEvidenceInvariants(values);
  console.log(
    JSON.stringify(
      {
        verdict: 'PASS',
        scope: 'COMMITTED_SYNTHETIC_STAGING_CONFIGURATION_ONLY',
        authority: SYNTHETIC_STAGING_CAMPAIGN_AUTHORITY,
        note: 'A deployed-binding inspection, named approvals, and human review remain separate evidence requirements.',
      },
      null,
      2,
    ),
  );
}
