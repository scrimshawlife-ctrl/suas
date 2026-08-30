/** Provision owner-approved STAGING browser-auth test identities. */

import { loadConfig } from '../config/index.js';
import { createPool } from '../db/index.js';
import { createUser, findUserByDestination, setUserStatus } from '../identity/index.js';

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (config.environment !== 'STAGING') {
    throw new Error('Browser-auth test-user provisioning is STAGING-only.');
  }
  if (config.browserAuth.mode !== 'email_otp' || config.browserAuth.tenantId !== TENANT_ID) {
    throw new Error('STAGING browser auth must be enabled for the canonical synthetic tenant.');
  }

  const raw = process.env['SUAS_STAGING_AUTH_EMAILS'];
  const emails = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (
    emails.length === 0 ||
    emails.length > 10 ||
    emails.some((email) => !EMAIL_SHAPE.test(email))
  ) {
    throw new Error('SUAS_STAGING_AUTH_EMAILS must contain 1-10 comma-separated email addresses.');
  }

  const pool = createPool(config);
  try {
    for (const email of emails) {
      const existing = await findUserByDestination(pool, TENANT_ID, email);
      if (existing === undefined) {
        await createUser(pool, { tenantId: TENANT_ID, email, status: 'ACTIVE' });
      } else if (existing.status !== 'ACTIVE') {
        await setUserStatus(pool, TENANT_ID, existing.userId, 'ACTIVE');
      }
    }
    console.log(JSON.stringify({ provisioned: emails.length, tenantId: TENANT_ID }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
