/**
 * STAGING synthetic-session refresh.
 *
 * Mints fresh bearer sessions for the operator-owned synthetic staging users and
 * writes them to $GITHUB_ENV (masked) so subsequent Playwright steps can pick
 * them up without stale credentials. Safe to run before every scheduled
 * acceptance run.
 *
 * Boundaries (SUAS-specs ENVIRONMENT.md §2, §5; TESTING.md §12; AGENTS.md):
 * - Refuses to run outside SUAS_ENV=STAGING.
 * - Never writes real veteran data; all identities are synthetic (reserved
 *   non-routable domains only).
 * - Only finds pre-existing synthetic users — it does not create or modify any
 *   domain record beyond sessions.
 * - Uses the same session secret as the deployed Worker so hashes match.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §5 — sessions are server-revocable opaque credentials.
 * - SUAS-specs ENVIRONMENT.md §2 — LOCAL/TEST/STAGING use only synthetic data.
 * - SUAS-specs ENVIRONMENT.md §5 — startup refuses if required secrets absent.
 * - SUAS-specs TESTING.md §11 — readiness evidence exercises deployed boundaries.
 *
 * Usage (GitHub Actions):
 *   Set STAGING_DATABASE_URL and SUAS_SESSION_SECRET in the `suas-synthetic-staging`
 *   GitHub Environment. The step that runs this script must expose them via `env:`.
 *   Output credentials are masked via `::add-mask::` and appended to $GITHUB_ENV
 *   so the Playwright step that follows can read them as fresh env vars.
 */

import { appendFileSync } from 'node:fs';
import { createPool } from '../db/index.js';
import { loadConfig } from '../config/index.js';
import { createSession } from '../auth/index.js';
import { findUserByDestination } from '../identity/users.js';
import { syntheticEmail } from '../testing/fixture-boundary.js';

/** Fixed synthetic tenant — must match seed-local.ts. */
const TENANT_ID = '00000000-0000-4000-8000-000000000001';

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  if (config.environment !== 'STAGING') {
    throw new Error(
      `seed-staging-sessions refuses to run in ${config.environment}; it is for STAGING only ` +
        `(SUAS-specs ENVIRONMENT.md §2). Set SUAS_ENV=STAGING.`,
    );
  }

  const pool = createPool(config);
  try {
    const veteranEmail = syntheticEmail('veteran');
    const accepterEmail = syntheticEmail('accepter');

    const veteran = await findUserByDestination(pool, TENANT_ID, veteranEmail);
    const accepter = await findUserByDestination(pool, TENANT_ID, accepterEmail);

    if (veteran === undefined) {
      throw new Error(
        `Synthetic veteran user (${veteranEmail}) not found in STAGING database. ` +
          `Run the initial seed against the STAGING database first.`,
      );
    }
    if (accepter === undefined) {
      throw new Error(
        `Synthetic accepter user (${accepterEmail}) not found in STAGING database. ` +
          `Run the initial seed against the STAGING database first.`,
      );
    }

    const veteranSession = await createSession(pool, config.sessionSecret, {
      tenantId: TENANT_ID,
      userId: veteran.userId,
    });
    const accepterSession = await createSession(pool, config.sessionSecret, {
      tenantId: TENANT_ID,
      userId: accepter.userId,
    });

    const githubEnvPath = process.env['GITHUB_ENV'];
    if (githubEnvPath !== undefined) {
      // Mask both credentials so they never appear in the Actions log.
      process.stdout.write(`::add-mask::${veteranSession.credential}\n`);
      process.stdout.write(`::add-mask::${accepterSession.credential}\n`);
      appendFileSync(
        githubEnvPath,
        `SUAS_E2E_VETERAN_BEARER=${veteranSession.credential}\n` +
          // The variable keeps its pre-v1 name: the workflows and secrets that read it
          // live outside this repo's code.
          `SUAS_E2E_RESPONDER_BEARER=${accepterSession.credential}\n`,
      );
    }

    // Print non-sensitive summary only.
    console.log(
      JSON.stringify(
        {
          veteran: {
            userId: veteran.userId,
            sessionId: veteranSession.session.sessionId,
            expiresAt: veteranSession.session.expiresAt.toISOString(),
          },
          accepter: {
            userId: accepter.userId,
            sessionId: accepterSession.session.sessionId,
            expiresAt: accepterSession.session.expiresAt.toISOString(),
          },
          githubEnvWritten: githubEnvPath !== undefined,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
