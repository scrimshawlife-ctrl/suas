/**
 * STAGING fixture seed (R11.5, contributor proposal in specs #75, not released).
 *
 * Creates the users the fixture registry (SUAS_STAGING_FIXTURE_REGISTRY, D-052) admits and a
 * few synthetic, clearly marked Resources, so a fresh AWS STAGING has someone who can sign in
 * and something to show. The database sits in isolated subnets, so the migrate Lambda runs it.
 *
 * Boundaries (ENVIRONMENT.md §2, §3, §9 at the pin):
 * - STAGING only, and never while real external effects are enabled.
 * - Every address must be synthetic, or a plus address of the configured fixture mailbox
 *   (R11.7); the run refuses before any write otherwise.
 * - The schema version is checked before any write.
 * - Resources go through the Resource Draft publish (RESOURCES.md §5.1), the released path.
 * - No passed ID scan is seeded: a fake check cannot satisfy the gate in STAGING
 *   (VETERAN_VERIFICATION.md §1.1, D-052).
 *
 * Idempotent: users are keyed on their registry id and Resources on their name under the
 * fixture source link, so a re-run creates nothing new. All writes are one transaction.
 */

import type { Pool } from 'pg';
import { z } from 'zod';
import { isStagingFixtureAddress } from '../auth/staging-access.js';
import type { SuasConfig } from '../config/index.js';
import type { StagingFixturePrincipal } from '../config/schema.js';
import { createResourceDrafts, draftFieldsSchema, publishResourceDraft } from '../catalog/index.js';
import type { DraftFields } from '../catalog/fields.js';
import { assertExpectedSchemaVersion, withTransaction, type Queryable } from '../db/index.js';
import {
  createUser,
  findUserByDestination,
  findUserById,
  setUserCounty,
  setUserStatus,
  type ServiceCounty,
} from '../identity/index.js';
import {
  assertSyntheticEnvironment,
  syntheticEmail,
  syntheticPhone,
} from '../testing/fixture-boundary.js';

/** Fixture users and Resources share one launch county, so the lists have matches. */
export const STAGING_FIXTURE_COUNTY: ServiceCounty = 'SANTA_CLARA';

/** Source link of every fixture Resource Draft. A reserved, non-resolving host. */
export const STAGING_FIXTURE_SOURCE_LINK =
  'https://fixtures.example.invalid/suas-staging-resources';

/**
 * Reviewer of record for the fixture publishes (resource_drafts.reviewed_by needs a user).
 * SUSPENDED and absent from the registry, so it can never sign in.
 */
const PUBLISHER_EMAIL = syntheticEmail('staging-fixture-publisher');

const FIXTURE_ELIGIBILITY = 'Synthetic STAGING fixture. Not a real service.';

const STAGING_FIXTURE_RESOURCES: readonly DraftFields[] = [
  {
    service_name: 'Staging Fixture Food Pantry (synthetic)',
    category: 'FOOD',
    counties: [STAGING_FIXTURE_COUNTY],
    contact_method: syntheticPhone(40),
    contact_method_kind: 'PHONE',
    hours: 'Weekdays 9:00 to 16:00',
    cost: 'No cost',
    eligibility: FIXTURE_ELIGIBILITY,
  },
  {
    service_name: 'Staging Fixture Ride Desk (synthetic)',
    category: 'TRANSPORTATION',
    counties: [STAGING_FIXTURE_COUNTY],
    contact_method: syntheticPhone(41),
    contact_method_kind: 'PHONE',
    hours: 'By appointment',
    cost: 'No cost',
    eligibility: FIXTURE_ELIGIBILITY,
  },
  {
    service_name: 'Staging Fixture Shelter (synthetic)',
    category: 'SHELTER',
    counties: [STAGING_FIXTURE_COUNTY],
    contact_method: 'Walk-in intake at the front desk',
    contact_method_kind: 'FREEFORM',
    hours: 'Daily, evening intake',
    cost: 'No cost',
    eligibility: FIXTURE_ELIGIBILITY,
  },
  {
    service_name: 'Staging Fixture Peer Circle (synthetic)',
    category: 'PEER_SUPPORT',
    counties: [STAGING_FIXTURE_COUNTY],
    contact_method: syntheticEmail('staging-fixture-peer-circle'),
    contact_method_kind: 'EMAIL',
    hours: 'Weekly meeting',
    cost: 'No cost',
    eligibility: FIXTURE_ELIGIBILITY,
  },
];

/** One registry user and the synthetic address it signs in with. */
const fixtureAddressSchema = z
  .object({ user_id: z.string().uuid(), email: z.string().trim().min(3).max(254) })
  .strict();

/** The `fixtures` field of the invoke payload: one address per registry user. */
export const stagingFixtureAddressesSchema = z.array(fixtureAddressSchema).min(1).max(10);
export type StagingFixtureAddress = z.infer<typeof fixtureAddressSchema>;

/** A refusal: nothing was written. The message names the rule, never an address. */
export class StagingFixtureSeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingFixtureSeedRefusedError';
  }
}

export interface StagingFixtureSeedResult {
  readonly users_created: number;
  readonly users_existing: number;
  readonly resources_published: number;
  readonly resources_existing: number;
  /** tenant-id:user-id pairs seeded; identifiers only, no addresses. */
  readonly registry: string;
}

interface Planned extends StagingFixturePrincipal {
  readonly email: string;
}

/** Pair each registry principal with its address, or refuse. Runs before the database is touched. */
function planFixtures(
  registry: readonly StagingFixturePrincipal[],
  addresses: readonly StagingFixtureAddress[],
  mailbox: string | undefined,
): Planned[] {
  if (registry.length === 0) {
    throw new StagingFixtureSeedRefusedError(
      'SUAS_STAGING_FIXTURE_REGISTRY is empty: there are no fixture users to seed.',
    );
  }
  const byUser = new Map<string, string>();
  for (const entry of addresses) {
    const userId = entry.user_id.toLowerCase();
    const email = entry.email.toLowerCase();
    if (!isStagingFixtureAddress(email, mailbox)) {
      throw new StagingFixtureSeedRefusedError(
        `The address for user ${userId} is not synthetic and not a plus address of the fixture mailbox.`,
      );
    }
    if (byUser.has(userId) || [...byUser.values()].includes(email)) {
      throw new StagingFixtureSeedRefusedError('Each user id and each address may appear once.');
    }
    if (!registry.some((principal) => principal.userId === userId)) {
      throw new StagingFixtureSeedRefusedError(
        `User ${userId} is not in SUAS_STAGING_FIXTURE_REGISTRY.`,
      );
    }
    byUser.set(userId, email);
  }
  return registry.map((principal) => {
    const email = byUser.get(principal.userId);
    if (email === undefined) {
      throw new StagingFixtureSeedRefusedError(
        `Registry user ${principal.userId} has no address in the payload.`,
      );
    }
    return { ...principal, email };
  });
}

/** Create the user with its registry id, or bring an existing one to ACTIVE in the county. */
async function ensureFixtureUser(tx: Queryable, planned: Planned): Promise<'created' | 'existing'> {
  const existing = await findUserById(tx, planned.tenantId, planned.userId);
  if (existing !== undefined) {
    if (existing.email?.toLowerCase() !== planned.email) {
      throw new StagingFixtureSeedRefusedError(
        `User ${planned.userId} already exists with another address.`,
      );
    }
    if (existing.status !== 'ACTIVE') {
      await setUserStatus(tx, planned.tenantId, planned.userId, 'ACTIVE');
    }
    if (existing.county === undefined) {
      await setUserCounty(tx, planned.tenantId, planned.userId, STAGING_FIXTURE_COUNTY);
    }
    return 'existing';
  }
  const holder = await findUserByDestination(tx, planned.tenantId, planned.email);
  if (holder !== undefined) {
    throw new StagingFixtureSeedRefusedError(
      `The address for user ${planned.userId} already belongs to user ${holder.userId}.`,
    );
  }
  await createUser(tx, {
    tenantId: planned.tenantId,
    userId: planned.userId,
    email: planned.email,
    status: 'ACTIVE',
    county: STAGING_FIXTURE_COUNTY,
  });
  return 'created';
}

async function ensurePublisher(tx: Queryable, tenantId: string): Promise<string> {
  const existing = await findUserByDestination(tx, tenantId, PUBLISHER_EMAIL);
  if (existing !== undefined) return existing.userId;
  const created = await createUser(tx, { tenantId, email: PUBLISHER_EMAIL, status: 'SUSPENDED' });
  return created.userId;
}

/** Draft and publish each fixture Resource not yet published under the fixture source link. */
async function ensureFixtureResources(
  tx: Queryable,
  tenantId: string,
): Promise<{ published: number; existing: number }> {
  const actorId = await ensurePublisher(tx, tenantId);
  let published = 0;
  let existing = 0;
  for (const fields of STAGING_FIXTURE_RESOURCES) {
    const found = await tx.query(
      `SELECT 1 FROM resource_drafts
        WHERE tenant_id = $1 AND source_url = $2 AND service_name = $3 AND status = 'PUBLISHED'`,
      [tenantId, STAGING_FIXTURE_SOURCE_LINK, fields.service_name],
    );
    if ((found.rowCount ?? 0) > 0) {
      existing += 1;
      continue;
    }
    const [draft] = await createResourceDrafts(tx, {
      tenantId,
      actorId,
      sourceLink: STAGING_FIXTURE_SOURCE_LINK,
      resources: [draftFieldsSchema.parse(fields)],
    });
    if (draft === undefined) throw new Error('Resource Draft insert returned no draft.');
    await publishResourceDraft(tx, {
      tenantId,
      resourceDraftId: draft.resourceDraftId,
      actorId,
    });
    published += 1;
  }
  return { published, existing };
}

/** Refuse unless STAGING, the payload is valid and synthetic, and the schema is current; then seed. */
export async function seedStagingFixtures(
  pool: Pool,
  config: SuasConfig,
  fixtures: unknown,
): Promise<StagingFixtureSeedResult> {
  if (config.environment !== 'STAGING') {
    throw new StagingFixtureSeedRefusedError(
      `seed-staging-fixtures runs in STAGING only, not ${config.environment}.`,
    );
  }
  assertSyntheticEnvironment(config);
  const parsed = stagingFixtureAddressesSchema.safeParse(fixtures);
  if (!parsed.success) {
    throw new StagingFixtureSeedRefusedError(
      '`fixtures` must list 1-10 objects of the form {"user_id": "<uuid>", "email": "<address>"}.',
    );
  }
  const planned = planFixtures(
    config.stagingFixturePrincipals,
    parsed.data,
    config.stagingFixtureMailbox,
  );

  // ENVIRONMENT.md §9: refuse a schema this build cannot operate against.
  await assertExpectedSchemaVersion(pool);

  return withTransaction(pool, async (tx) => {
    let created = 0;
    for (const fixture of planned) {
      if ((await ensureFixtureUser(tx, fixture)) === 'created') created += 1;
    }
    let published = 0;
    let existing = 0;
    for (const tenantId of new Set(planned.map((fixture) => fixture.tenantId))) {
      const counts = await ensureFixtureResources(tx, tenantId);
      published += counts.published;
      existing += counts.existing;
    }
    return {
      users_created: created,
      users_existing: planned.length - created,
      resources_published: published,
      resources_existing: existing,
      registry: planned.map((fixture) => `${fixture.tenantId}:${fixture.userId}`).join(','),
    };
  });
}
