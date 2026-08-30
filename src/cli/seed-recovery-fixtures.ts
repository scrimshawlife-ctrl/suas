/**
 * Provision deterministic recovery fixtures in synthetic STAGING.
 *
 * This command intentionally requires a second explicit confirmation variable.
 * It creates only inert `synthetic.recovery.*` job rows and never invokes workers,
 * providers, notifications, or real-world effects.
 */

import { loadConfig } from '../config/index.js';
import { createPool } from '../db/index.js';
import { assertSyntheticEnvironment } from '../testing/fixture-boundary.js';
import { seedRecoveryFixtures } from '../testing/recovery-fixtures.js';

const CONFIRMATION = 'INSTALL_SYNTHETIC_RECOVERY_FIXTURES';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  assertSyntheticEnvironment(config);
  if (config.environment !== 'STAGING') {
    throw new Error(
      `seed-recovery-fixtures refuses to run in ${config.environment}; it is for synthetic STAGING only.`,
    );
  }
  if (process.env['SUAS_RECOVERY_FIXTURE_CONFIRM'] !== CONFIRMATION) {
    throw new Error(
      `Set SUAS_RECOVERY_FIXTURE_CONFIRM=${CONFIRMATION} to authorize deterministic synthetic fixture installation.`,
    );
  }
  const pool = createPool(config);
  try {
    const summary = await seedRecoveryFixtures(pool);
    console.log(
      JSON.stringify(
        {
          fixtureVersion: summary.version,
          total: summary.total,
          statuses: summary.statuses,
          syntheticOnly: true,
          externalEffects: false,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
