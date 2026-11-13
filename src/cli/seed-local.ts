/**
 * LOCAL synthetic-data seed.
 *
 * Populates a coherent, recognizably-fictitious dataset in the LOCAL database so
 * a developer has something to see across the reference surfaces: a SUAS
 * admin, a person who accepts requests, veterans, an active QRF (Support Case + PEER_SUPPORT
 * Service Request), and an active/verified Resource catalog. It also mints
 * sessions and prints their bearer credentials for the authenticated surfaces.
 *
 * Boundaries (SUAS-specs ENVIRONMENT.md §2, §7; TESTING.md §12; AGENTS.md):
 * - Refuses to run outside SUAS_ENV=LOCAL and refuses when real external effects
 *   are enabled. It never writes real veteran data.
 * - All contact data is synthetic (reserved non-routable domains only).
 * - Every row is written through the same domain commands the app uses, so real
 *   invariants (tenant scope, one-active-case, transitions, verify-before-active)
 *   hold. Nothing here upgrades an UNAVAILABLE/MANUAL_ONLY/FUTURE surface: no
 *   Support Signal score, crisis copy, or real provider effect is fabricated.
 *
 * Idempotent: keyed on synthetic destinations / names, so re-running converges on
 * the same dataset rather than duplicating it. Sessions are minted fresh per run.
 *
 * Usage: npm run seed   (requires PostgreSQL running and .env exported)
 */

import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import {
  assertSyntheticEnvironment,
  syntheticEmail,
  syntheticPhone,
} from '../testing/fixture-boundary.js';
import { loadConfig } from '../config/index.js';
import { resolveSyntheticStagingOrigin } from '../config/staging-host.js';
import { assertExpectedSchemaVersion, createPool, withTransaction } from '../db/index.js';
import {
  createUser,
  findUserByDestination,
  grantSuasAdmin,
  isSuasAdmin,
  setUserCounty,
  setUserDisplayName,
  setUserStatus,
  type User,
} from '../identity/index.js';
import { createSession, elevateSession } from '../auth/index.js';
import {
  createResource,
  seedManualAdapterConfigurations,
  setResourceActive,
  verifyResource,
  type Resource,
  type ResourceContact,
} from '../fulfillment/index.js';
import { ensurePublishedQv001 } from '../signals/index.js';
import {
  acceptRequestInTx,
  createServiceRequest,
  executeCaseCommand,
  executeServiceRequestCommand,
  findCase,
  findCurrentCase,
  listCaseServiceRequests,
  lockCase,
  openCase,
  TERMINAL_REQUEST_STATUSES,
  type CaseStatus,
  type SupportCase,
} from '../coordination/index.js';
import {
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  findActiveGrant,
  findConsentTemplateVersion,
  grantConsent,
  inviteTrustedContact,
  listTrustedCircle,
  publishConsentTemplateVersion,
  RED_ALERT_CONSENT_TEMPLATE_KEY,
} from '../consent/index.js';
import { enqueueNotification, listNotificationsForRecipient } from '../notifications/index.js';
import {
  completeFollowUp,
  createFollowUp,
  findCurrentSettlement,
  resolveCaseWithSettlement,
} from '../settlement/index.js';

/** Fixed synthetic tenant so re-runs converge rather than multiply. */
export const TENANT_ID = '00000000-0000-4000-8000-000000000001';
/** Synthetic users and resources all live in one launch county so the lists have matches. */
const SEED_COUNTY = 'SANTA_CLARA' as const;

interface ResourceRow {
  resource_id: string;
}

/** Creates the synthetic user if missing; a given display name is set once, never overwritten. */
export async function getOrCreateUser(
  pool: Pool,
  localPart: string,
  displayName?: string,
): Promise<User> {
  const email = syntheticEmail(localPart);
  const existing = await findUserByDestination(pool, TENANT_ID, email);
  let current: User;
  if (existing !== undefined) {
    current = existing;
    if (current.status !== 'ACTIVE') {
      current = (await setUserStatus(pool, TENANT_ID, current.userId, 'ACTIVE')) ?? current;
    }
    if (current.county === undefined) {
      current = (await setUserCounty(pool, TENANT_ID, current.userId, SEED_COUNTY)) ?? current;
    }
  } else {
    current = await createUser(pool, {
      tenantId: TENANT_ID,
      email,
      status: 'ACTIVE',
      county: SEED_COUNTY,
    });
  }
  if (displayName !== undefined && current.displayName === undefined) {
    current = (await setUserDisplayName(pool, TENANT_ID, current.userId, displayName)) ?? current;
  }
  return current;
}

export interface ResourceSpec {
  readonly serviceName: string;
  readonly category: string;
  readonly counties: readonly string[];
  readonly contactMethod: string;
  /** P-13 scheme, so the seeded catalog shows direct call/email/web actions. */
  readonly contactMethodKind?: 'PHONE' | 'EMAIL' | 'URL' | 'FREEFORM';
  /** R8.8 list; its first entry must match `contactMethod` and its kind. */
  readonly contacts?: readonly ResourceContact[];
  /** R8.9 area line. */
  readonly area?: string;
  readonly hours: string;
  readonly cost: string;
  readonly eligibility: string;
}

const RESOURCE_SPECS: readonly ResourceSpec[] = [
  {
    serviceName: 'Example Community Food Pantry (synthetic)',
    category: 'FOOD',
    counties: ['SANTA_CLARA'],
    // Structured PHONE: the veteran resource list renders a direct `tel:` action.
    contactMethod: syntheticPhone(1),
    contactMethodKind: 'PHONE',
    contacts: [
      { kind: 'PHONE', value: syntheticPhone(1) },
      { kind: 'URL', value: 'https://pantry.example.invalid' },
      { kind: 'EMAIL', value: syntheticEmail('pantry') },
    ],
    area: 'San Jose, east side',
    hours: 'Weekdays, morning to afternoon',
    cost: 'No cost',
    eligibility: 'All veterans',
  },
  {
    serviceName: 'Example Volunteer Rides (synthetic)',
    category: 'TRANSPORTATION',
    counties: ['SANTA_CLARA'],
    // Unstructured: shown as text, no action guessed.
    contactMethod: 'Request through the person who accepts your request',
    hours: 'By appointment',
    cost: 'No cost',
    eligibility: 'All veterans',
  },
  {
    serviceName: 'Example Emergency Shelter (synthetic)',
    category: 'SHELTER',
    counties: ['SANTA_CLARA'],
    contactMethod: 'Walk-in intake at the front desk',
    hours: 'Daily, evening intake',
    cost: 'No cost',
    eligibility: 'All veterans',
  },
  {
    serviceName: 'Example Peer Support Circle (synthetic)',
    category: 'PEER_SUPPORT',
    counties: ['SANTA_CLARA'],
    // Structured EMAIL: renders a direct `mailto:` action.
    contactMethod: syntheticEmail('peer-support'),
    contactMethodKind: 'EMAIL',
    hours: 'Weekly meeting',
    cost: 'No cost',
    eligibility: 'All veterans',
  },
];

export async function ensureResource(
  pool: Pool,
  spec: ResourceSpec,
  actorId: string,
): Promise<string> {
  const found = await pool.query<ResourceRow>(
    `SELECT resource_id FROM resources
     WHERE tenant_id = $1 AND service_name = $2 AND category = $3::suas_service_category
     LIMIT 1`,
    [TENANT_ID, spec.serviceName, spec.category],
  );
  const existingId = found.rows[0]?.resource_id;
  if (existingId !== undefined) {
    // Seeds written before the counties used the county enum values converge on re-run.
    await pool.query(
      `UPDATE resources SET counties = $3::text[]
       WHERE tenant_id = $1 AND resource_id = $2 AND counties IS DISTINCT FROM $3::text[]`,
      [TENANT_ID, existingId, [...spec.counties]],
    );
    if (spec.contacts !== undefined || spec.area !== undefined) {
      await pool.query(
        `UPDATE resources SET contacts = $3::jsonb, area = $4
         WHERE tenant_id = $1 AND resource_id = $2
           AND (contacts IS DISTINCT FROM $3::jsonb OR area IS DISTINCT FROM $4)`,
        [TENANT_ID, existingId, JSON.stringify(spec.contacts ?? []), spec.area ?? null],
      );
    }
    await setResourceActive(pool, {
      tenantId: TENANT_ID,
      resourceId: existingId,
      active: true,
      actorId,
    });
    return existingId;
  }

  const resource: Resource = await createResource(pool, {
    tenantId: TENANT_ID,
    serviceName: spec.serviceName,
    category: spec.category,
    counties: spec.counties,
    contactMethod: spec.contactMethod,
    ...(spec.contactMethodKind === undefined ? {} : { contactMethodKind: spec.contactMethodKind }),
    ...(spec.contacts === undefined ? {} : { contacts: spec.contacts }),
    ...(spec.area === undefined ? {} : { area: spec.area }),
    hours: spec.hours,
    cost: spec.cost,
    eligibility: spec.eligibility,
  });
  await verifyResource(pool, {
    tenantId: TENANT_ID,
    resourceId: resource.resourceId,
    verificationSource: 'Synthetic local seed',
    actorId,
  });
  await setResourceActive(pool, {
    tenantId: TENANT_ID,
    resourceId: resource.resourceId,
    active: true,
    actorId,
  });
  return resource.resourceId;
}

async function ensureActiveQrf(
  pool: Pool,
  veteran: User,
  accepter: User,
): Promise<{ supportCase: SupportCase; serviceRequestId: string }> {
  const opened = await withTransaction(pool, (tx: PoolClient) =>
    openCase(tx, {
      tenantId: TENANT_ID,
      veteranUserId: veteran.userId,
      actorType: 'VETERAN',
      actorId: veteran.userId,
    }),
  );
  const supportCase = opened.supportCase;

  const requests = await listCaseServiceRequests(pool, TENANT_ID, supportCase.caseId);
  const activePeer = requests.find(
    (r) =>
      r.category === 'PEER_SUPPORT' &&
      !['CLOSED', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'UNFULFILLABLE'].includes(r.status),
  );
  const request =
    activePeer ??
    (await withTransaction(pool, (tx: PoolClient) =>
      createServiceRequest(tx, {
        tenantId: TENANT_ID,
        caseId: supportCase.caseId,
        category: 'PEER_SUPPORT',
        createdBy: veteran.userId,
        actorType: 'VETERAN',
      }),
    ));

  // The helper accepts the request, not the case: submit it, then record the accept.
  if (request.status === 'CREATED') {
    await executeServiceRequestCommand(pool, {
      tenantId: TENANT_ID,
      serviceRequestId: request.serviceRequestId,
      command: 'SUBMIT',
      actorId: veteran.userId,
      actorType: 'VETERAN',
    });
  }
  await acceptForSeed(pool, request.serviceRequestId, accepter);
  return {
    supportCase: await refetchCase(pool, supportCase.caseId),
    serviceRequestId: request.serviceRequestId,
  };
}

/** Record an accept for a seeded request. Skips one that is already held. */
async function acceptForSeed(pool: Pool, serviceRequestId: string, accepter: User): Promise<void> {
  await withTransaction(pool, async (tx: PoolClient) => {
    const current = await tx.query<{ case_id: string; accepted_by_user_id: string | null }>(
      `SELECT case_id, accepted_by_user_id FROM service_requests
        WHERE tenant_id = $1 AND service_request_id = $2`,
      [TENANT_ID, serviceRequestId],
    );
    const row = current.rows[0];
    if (row === undefined || row.accepted_by_user_id !== null) return;
    const supportCase = await lockCase(tx, TENANT_ID, row.case_id);
    await acceptRequestInTx(tx, {
      tenantId: TENANT_ID,
      supportCase,
      serviceRequestId,
      acceptedByUserId: accepter.userId,
    });
  });
}

async function refetchCase(pool: Pool, caseId: string): Promise<SupportCase> {
  const supportCase = await findCase(pool, TENANT_ID, caseId);
  if (supportCase === undefined) throw new Error(`Seeded case ${caseId} vanished mid-seed.`);
  return supportCase;
}

/**
 * The CONSENT stage: a published template and one active grant. Consent is
 * first-class (CONSENT.md §1), so the seed shows a real grant rather than a
 * boolean. Idempotent: the template is get-or-create and the grant is skipped
 * when an identical live one already exists.
 */
async function ensurePublishedTemplate(
  pool: Pool,
  templateKey: string,
  body: string,
  publishedBy: string,
): Promise<void> {
  const versionKey = consentTemplateVersionKey(templateKey, 1);
  const template = await findConsentTemplateVersion(pool, versionKey);
  if (template === undefined) {
    await createConsentTemplateVersion(pool, { templateKey, version: 1, body });
  }
  if (template === undefined || template.status === 'DRAFT') {
    await publishConsentTemplateVersion(pool, versionKey, publishedBy);
  }
}

async function ensureConsent(pool: Pool, veteran: User, accepter: User): Promise<string> {
  await ensurePublishedTemplate(
    pool,
    'local-seed-consent',
    'Synthetic consent template — local development only.',
    accepter.userId,
  );
  // The RED-alert grant the web offers on the Trusted contacts page (R9.3).
  await ensurePublishedTemplate(
    pool,
    RED_ALERT_CONSENT_TEMPLATE_KEY,
    'Synthetic test template for the RED-alert notice — local development only.',
    accepter.userId,
  );
  const versionKey = consentTemplateVersionKey('local-seed-consent', 1);

  const existing = await findActiveGrant(pool, {
    tenantId: TENANT_ID,
    veteranUserId: veteran.userId,
    permission: 'can_view',
    scope: 'current_requests',
    granteeType: 'USER',
    granteeId: accepter.userId,
  });
  if (existing !== undefined) return existing.consentGrantId;

  const grant = await grantConsent(pool, {
    tenantId: TENANT_ID,
    veteranUserId: veteran.userId,
    permission: 'can_view',
    scope: 'current_requests',
    purpose: "Coordinate the veteran's active support requests (synthetic seed).",
    granteeType: 'USER',
    granteeId: accepter.userId,
    consentTemplateVersion: versionKey,
  });
  return grant.consentGrantId;
}

/**
 * One INVITED trusted contact so `/app/trusted-contacts` is non-empty. Invite
 * email is synthetic and never rendered on HTML.
 */
async function ensureTrustedContact(pool: Pool, veteran: User): Promise<string> {
  const existing = await listTrustedCircle(pool, TENANT_ID, veteran.userId);
  const match = existing.find((c) => c.relationshipLabel === 'Battle buddy (synthetic)');
  if (match !== undefined) return match.trustedContactId;
  const invited = await inviteTrustedContact(pool, {
    tenantId: TENANT_ID,
    veteranUserId: veteran.userId,
    relationshipLabel: 'Battle buddy (synthetic)',
    inviteEmail: syntheticEmail('battle-buddy'),
  });
  return invited.trustedContactId;
}

/**
 * A few IN_APP logical sends for the veteran inbox (system basis — no external
 * disclosure). Idempotent via dedupe keys.
 */
async function ensureVeteranNotifications(
  pool: Pool,
  veteran: User,
  serviceRequestId: string,
): Promise<number> {
  const already = await listNotificationsForRecipient(pool, TENANT_ID, veteran.userId, 20);
  if (already.length >= 2) return already.length;

  const disclosure = {
    tenantId: TENANT_ID,
    veteranUserId: veteran.userId,
    permission: 'can_view' as const,
    scope: 'current_requests' as const,
    granteeType: 'SYSTEM' as const,
    granteeId: 'notifications',
    purpose: 'Notify the veteran about their own request',
    systemBasis: 'SYSTEM_INTERNAL_PROCESSING' as const,
  };

  await enqueueNotification(pool, {
    tenantId: TENANT_ID,
    recipientUserId: veteran.userId,
    reason: 'qrf.veteran_ack',
    channel: 'IN_APP',
    templateVersion: 'seed@1',
    dedupeKey: `seed:veteran-ack:${serviceRequestId}`,
    subjectType: 'ServiceRequest',
    subjectId: serviceRequestId,
    disclosure,
  });
  await enqueueNotification(pool, {
    tenantId: TENANT_ID,
    recipientUserId: veteran.userId,
    reason: 'case.status_changed',
    channel: 'IN_APP',
    templateVersion: 'seed@1',
    dedupeKey: `seed:case-status:${serviceRequestId}`,
    subjectType: 'ServiceRequest',
    subjectId: serviceRequestId,
    disclosure,
  });
  const after = await listNotificationsForRecipient(pool, TENANT_ID, veteran.userId, 20);
  return after.length;
}

/**
 * A second veteran resolved through the release's first-class MANUAL path:
 * open → claim → activate → a completed Follow-Up → resolve with a Settlement →
 * close. It uses no external-provider disclosure, so no real effect occurs.
 *
 * Status-driven so it is idempotent and resumable: a CLOSED case is left alone,
 * and a partially advanced one continues from its current status.
 */
async function ensureSettledCase(
  pool: Pool,
  veteran: User,
  accepter: User,
): Promise<{ caseId: string; status: CaseStatus; settlementId: string | undefined }> {
  // The seeded settled case is the Veteran's CLOSED case with a Settlement. Once it exists
  // the seed leaves it alone, whatever the Veteran did afterwards: a later case of their own
  // (a request made while trying the app) is theirs, and resolving it here would fail on its
  // open requests.
  const closed = await pool.query<{ case_id: string }>(
    `SELECT case_id FROM support_cases
     WHERE tenant_id = $1 AND veteran_user_id = $2 AND status = 'CLOSED'
     ORDER BY created_at LIMIT 1`,
    [TENANT_ID, veteran.userId],
  );
  const existing = closed.rows[0];
  if (existing !== undefined) {
    const settlement = await findCurrentSettlement(pool, TENANT_ID, existing.case_id);
    return { caseId: existing.case_id, status: 'CLOSED', settlementId: settlement?.settlementId };
  }

  // A current case with live requests is the Veteran's own work, not seed data: leave it.
  const current = await findCurrentCase(pool, TENANT_ID, veteran.userId);
  if (current !== undefined) {
    const live = await listCaseServiceRequests(pool, TENANT_ID, current.caseId);
    if (live.some((request) => !TERMINAL_REQUEST_STATUSES.includes(request.status))) {
      return { caseId: current.caseId, status: current.status, settlementId: undefined };
    }
  }

  const opened = await withTransaction(pool, (tx: PoolClient) =>
    openCase(tx, {
      tenantId: TENANT_ID,
      veteranUserId: veteran.userId,
      actorType: 'VETERAN',
      actorId: veteran.userId,
    }),
  );
  let supportCase = opened.supportCase;

  if (supportCase.status === 'OPEN') {
    // The case is held through a request: a finished one the helper accepted.
    const created = await withTransaction(pool, (tx: PoolClient) =>
      createServiceRequest(tx, {
        tenantId: TENANT_ID,
        caseId: supportCase.caseId,
        category: 'PEER_SUPPORT',
        createdBy: veteran.userId,
        actorType: 'VETERAN',
        details: { summary: 'Someone to talk with about a hard week (synthetic).' },
      }),
    );
    const requestId = created.serviceRequestId;
    const run = (command: 'SUBMIT' | 'START' | 'FULFILL' | 'CONFIRM' | 'CLOSE', by: User) =>
      executeServiceRequestCommand(pool, {
        tenantId: TENANT_ID,
        serviceRequestId: requestId,
        command,
        actorId: by.userId,
        actorType: by === veteran ? 'VETERAN' : 'USER',
      });
    await run('SUBMIT', veteran);
    await acceptForSeed(pool, requestId, accepter);
    await run('START', accepter);
    await run('FULFILL', accepter);
    await run('CONFIRM', veteran);
    await run('CLOSE', accepter);
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  if (supportCase.status === 'ASSIGNED') {
    await executeCaseCommand(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      command: 'ACTIVATE',
      actorId: accepter.userId,
      actorType: 'USER',
    });
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  // A single completed Follow-Up: creation is one-shot, completion idempotent.
  const followUps = await pool.query<{ follow_up_id: string }>(
    `SELECT follow_up_id FROM follow_ups WHERE tenant_id = $1 AND case_id = $2
     ORDER BY created_at LIMIT 1`,
    [TENANT_ID, supportCase.caseId],
  );
  let followUpId = followUps.rows[0]?.follow_up_id;
  if (followUpId === undefined) {
    const created = await createFollowUp(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      dueAt: new Date(),
      responsibleType: 'USER',
      responsibleId: accepter.userId,
      actorId: accepter.userId,
      actorType: 'USER',
    });
    followUpId = created.followUpId;
  }
  await completeFollowUp(pool, {
    tenantId: TENANT_ID,
    followUpId,
    actorId: accepter.userId,
    actorType: 'USER',
  });

  if (supportCase.status === 'ACTIVE') {
    await resolveCaseWithSettlement(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      actorId: accepter.userId,
      content: {
        requested: { summary: 'Peer support and food navigation (synthetic).' },
        occurred: {
          summary: 'The accepter coordinated support manually; one Follow-Up completed.',
        },
        fulfilled: { summary: 'Immediate need met through manual peer coordination.' },
        unresolved: { summary: 'No open needs at settlement.' },
        authoredBy: accepter.userId,
        acceptedByUserId: accepter.userId,
      },
      idempotencyKey: `seed-resolve:${supportCase.caseId}`,
    });
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  if (supportCase.status === 'RESOLVED') {
    await executeCaseCommand(pool, {
      tenantId: TENANT_ID,
      caseId: supportCase.caseId,
      command: 'CLOSE',
      actorId: accepter.userId,
      actorType: 'USER',
    });
    supportCase = await refetchCase(pool, supportCase.caseId);
  }

  const settlement = await findCurrentSettlement(pool, TENANT_ID, supportCase.caseId);
  return {
    caseId: supportCase.caseId,
    status: supportCase.status,
    settlementId: settlement?.settlementId,
  };
}

/** Everything the base LOCAL seed converges on. Reused by the demo seed. */
export interface LocalSeedResult {
  readonly admin: User;
  readonly accepter: User;
  readonly veteran: User;
  readonly veteranTwo: User;
  readonly resourceIds: readonly string[];
  readonly qrf: { supportCase: SupportCase; serviceRequestId: string };
  readonly consentGrantId: string;
  readonly trustedContactId: string;
  readonly notificationCount: number;
  readonly settled: { caseId: string; status: CaseStatus; settlementId: string | undefined };
}

/**
 * Converge the base LOCAL synthetic dataset. Idempotent. The caller owns the
 * pool and the LOCAL environment check.
 */
export interface LocalSeedOptions {
  /**
   * Local part of the primary Veteran's synthetic address. Defaults to `veteran`
   * (veteran@example.invalid); the LOCAL demo seed passes `demo`.
   */
  readonly veteranLocalPart?: string;
}

export async function runLocalSeed(
  pool: Pool,
  options: LocalSeedOptions = {},
): Promise<LocalSeedResult> {
  const admin = await getOrCreateUser(pool, 'admin', 'Admin A.');
  const accepter = await getOrCreateUser(pool, 'accepter', 'Dee R.');
  const veteran = await getOrCreateUser(pool, options.veteranLocalPart ?? 'veteran', 'Marcus T.');
  const veteranTwo = await getOrCreateUser(pool, 'veteran2', 'Ray K.');

  if (!(await isSuasAdmin(pool, admin.userId))) {
    await grantSuasAdmin(pool, admin.userId, admin.userId);
  }
  await ensurePublishedQv001(pool, admin.userId);
  await seedManualAdapterConfigurations(pool, TENANT_ID);

  const resourceIds: string[] = [];
  for (const spec of RESOURCE_SPECS) {
    resourceIds.push(await ensureResource(pool, spec, admin.userId));
  }

  const qrf = await ensureActiveQrf(pool, veteran, accepter);
  const consentGrantId = await ensureConsent(pool, veteran, accepter);
  const trustedContactId = await ensureTrustedContact(pool, veteran);
  const notificationCount = await ensureVeteranNotifications(pool, veteran, qrf.serviceRequestId);
  const settled = await ensureSettledCase(pool, veteranTwo, accepter);

  return {
    admin,
    accepter,
    veteran,
    veteranTwo,
    resourceIds,
    qrf,
    consentGrantId,
    trustedContactId,
    notificationCount,
    settled,
  };
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  if (config.environment !== 'LOCAL') {
    throw new Error(
      `The local seed refuses to run in ${config.environment}; it is for LOCAL development only ` +
        `(SUAS-specs ENVIRONMENT.md §2). Set SUAS_ENV=LOCAL.`,
    );
  }
  // Reuses the synthetic-fixture boundary: LOCAL/TEST/STAGING only, and never
  // with real external effects enabled.
  assertSyntheticEnvironment(config);

  const pool = createPool(config);
  try {
    // ENVIRONMENT.md §9: refuse a schema this build cannot operate against.
    await assertExpectedSchemaVersion(pool);
    const {
      admin,
      accepter,
      veteran,
      veteranTwo,
      resourceIds,
      qrf,
      consentGrantId,
      trustedContactId,
      notificationCount,
      settled,
    } = await runLocalSeed(pool);

    // Sessions are minted fresh each run so the printed credentials are live.
    const secret = config.sessionSecret;
    const veteranSession = await createSession(pool, secret, {
      tenantId: TENANT_ID,
      userId: veteran.userId,
    });
    const accepterSession = await createSession(pool, secret, {
      tenantId: TENANT_ID,
      userId: accepter.userId,
    });
    const adminSession = await withTransaction(pool, async (tx) => {
      const issued = await createSession(tx, secret, {
        tenantId: TENANT_ID,
        userId: admin.userId,
      });
      // Elevate directly (dev seed): the admin surfaces require an MFA-elevated
      // session (ADMIN.md §2; SECURITY.md §2).
      await elevateSession(tx, issued.session.sessionId);
      return issued;
    });

    const stagingBaseUrl = process.env.SUAS_E2E_BASE_URL
      ? resolveSyntheticStagingOrigin(process.env.SUAS_E2E_BASE_URL, 'SUAS_E2E_BASE_URL')
      : null;
    const summary = {
      environment: config.environment,
      tenantId: TENANT_ID,
      users: {
        admin: { userId: admin.userId, email: syntheticEmail('admin') },
        accepter: { userId: accepter.userId, email: syntheticEmail('accepter') },
        veteran: { userId: veteran.userId, email: syntheticEmail('veteran') },
        veteran2: { userId: veteranTwo.userId, email: syntheticEmail('veteran2') },
      },
      activeQrf: {
        caseId: qrf.supportCase.caseId,
        caseStatus: qrf.supportCase.status,
        serviceRequestId: qrf.serviceRequestId,
      },
      consentGrantId,
      trustedContactId,
      notificationCount,
      settledCase: {
        caseId: settled.caseId,
        caseStatus: settled.status,
        settlementId: settled.settlementId,
      },
      resources: { count: resourceIds.length, categories: RESOURCE_SPECS.map((s) => s.category) },
      sessions: {
        veteranBearer: veteranSession.credential,
        accepterBearer: accepterSession.credential,
        adminBearer: adminSession.credential,
        expiresAt: veteranSession.session.expiresAt.toISOString(),
      },
      stagingBaseUrl: stagingBaseUrl ?? 'UNCONFIGURED_INDEPENDENT_SUAS_STAGING_ORIGIN',
      hint: stagingBaseUrl
        ? 'Use the bearer with: curl -H "authorization: Bearer <cred>" ' +
          `${stagingBaseUrl}/app/home`
        : 'Set SUAS_E2E_BASE_URL to the SUAS synthetic-STAGING origin before using these credentials against it.',
    };
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

// Run only as a CLI entry point, so the demo seed can import runLocalSeed.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
