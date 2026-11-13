/** Provision owner-approved STAGING browser-auth test identities. */

import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';

import { DEMO_FIXED_CODE_DESTINATION } from '../auth/demo-fixed-code.js';
import { loadConfig } from '../config/index.js';
import { assertExpectedSchemaVersion, createPool } from '../db/index.js';
import { createUser, findUserByDestination, setUserStatus } from '../identity/index.js';

export const STAGING_AUTH_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The (tenant id, user id) pair the staging gate admits. No secrets and no addresses. */
export interface ProvisionedFixture {
  readonly tenantId: string;
  readonly userId: string;
}

export interface StagingFixtureRegistryArtifact {
  readonly principals: readonly ProvisionedFixture[];
}

/** Comma-separated tenant-id:user-id list for SUAS_STAGING_FIXTURE_REGISTRY. */
export function stagingFixtureRegistryValue(artifact: StagingFixtureRegistryArtifact): string {
  return artifact.principals
    .map((principal) => `${principal.tenantId}:${principal.userId}`)
    .join(',');
}

/**
 * Create or reuse only the explicitly requested fixtures and return the registry
 * the staging gate reads. The demo account is included only when its address is
 * one of those addresses.
 */
export async function provisionExplicitFixtures(
  pool: Pool,
  emails: readonly string[],
): Promise<StagingFixtureRegistryArtifact> {
  const principals: ProvisionedFixture[] = [];
  for (const email of emails) {
    principals.push(await ensureActiveUser(pool, email));
  }
  return { principals };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.environment !== 'STAGING') {
    throw new Error('Browser-auth test-user provisioning is STAGING-only.');
  }
  if (
    config.browserAuth.mode !== 'email_otp' ||
    config.browserAuth.tenantId !== STAGING_AUTH_TENANT_ID
  ) {
    throw new Error('STAGING browser auth must be enabled for the canonical synthetic tenant.');
  }

  const emails = config.stagingAuthEmails;
  if (emails.length === 0 || emails.some((email) => !EMAIL_SHAPE.test(email))) {
    throw new Error(
      'SUAS_STAGING_AUTH_EMAILS must contain 1-10 comma-separated synthetic fixture addresses.',
    );
  }

  const pool = createPool(config);
  try {
    // ENVIRONMENT.md §9: refuse a schema this build cannot operate against.
    await assertExpectedSchemaVersion(pool);
    const artifact = await provisionExplicitFixtures(pool, emails);
    // Reviewable registry for SUAS_STAGING_FIXTURE_REGISTRY. Identifiers only:
    // no addresses, credentials, or session material.
    console.log(
      JSON.stringify({
        registry: stagingFixtureRegistryValue(artifact),
        demoAccount: emails.includes(DEMO_FIXED_CODE_DESTINATION),
      }),
    );
  } finally {
    await pool.end();
  }
}

async function ensureActiveUser(pool: Pool, email: string): Promise<ProvisionedFixture> {
  const existing = await findUserByDestination(pool, STAGING_AUTH_TENANT_ID, email);
  if (existing === undefined) {
    const created = await createUser(pool, {
      tenantId: STAGING_AUTH_TENANT_ID,
      email,
      status: 'ACTIVE',
    });
    return { tenantId: created.tenantId, userId: created.userId };
  }
  if (existing.status !== 'ACTIVE') {
    await setUserStatus(pool, STAGING_AUTH_TENANT_ID, existing.userId, 'ACTIVE');
  }
  return { tenantId: existing.tenantId, userId: existing.userId };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
