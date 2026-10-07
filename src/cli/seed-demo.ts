/**
 * LOCAL-only demo seed for SUAS.
 *
 * This script runs the existing base seed (`runLocalSeed`) and then layers extra synthetic demo
 * data so that every Veteran journey the native clients (iOS/Android) and the web `/app` surface
 * has something truthful to show: home, an open case with Service Requests in different states,
 * a completed Check-In, a Follow-Up addressed to the veteran, a richer resource catalog, and a
 * fresh veteran with no case yet.
 *
 * Everything written here is synthetic. Emails use `@example.invalid` only and phone numbers use
 * the 555-0100..555-0199 fictitious range via `syntheticEmail` / `syntheticPhone` (see
 * ENVIRONMENT.md section 2 and section 7, and TESTING.md section 12). Writes go through the
 * domain commands so existing invariants hold rather than being bypassed with raw SQL. The script
 * is idempotent: re-running converges and never duplicates rows.
 *
 * No Support Signal score, crisis copy, or provider effect is fabricated here. Chat has no
 * released message store, so nothing is seeded for it. Raw SQL is used for read-only idempotency
 * lookups only.
 *
 * Usage: `npm run seed:demo`.
 */

import { pathToFileURL } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { loadConfig } from '../config/index.js';
import {
  assertSyntheticEnvironment,
  syntheticEmail,
  syntheticPhone,
} from '../testing/fixture-boundary.js';
import { createPool, withTransaction } from '../db/index.js';
import { createSession, elevateSession } from '../auth/index.js';
import {
  runLocalSeed,
  getOrCreateUser,
  ensureResource,
  TENANT_ID,
  type ResourceSpec,
} from './seed-local.js';
import {
  createServiceRequest,
  executeServiceRequestCommand,
  listCaseServiceRequests,
  type ServiceRequest,
  type ServiceRequestCommand,
  type ServiceRequestStatus,
} from '../coordination/index.js';
import { findActiveGrant } from '../consent/index.js';
import {
  startCheckIn,
  listQuestionsWithOptions,
  saveResponse,
  completeCheckIn,
} from '../signals/index.js';
import { createFollowUp } from '../settlement/index.js';

type SeedUser = Awaited<ReturnType<typeof getOrCreateUser>>;

type DemoActors = {
  readonly veteranUserId: string;
  readonly responderUserId: string;
};

type AdvanceStep = {
  command: ServiceRequestCommand;
  actor: 'veteran' | 'responder';
  reason?: string;
  granteeId?: string;
};

const DEMO_RESOURCES: readonly ResourceSpec[] = [
  {
    serviceName: 'Demo Harbor Food Bank (synthetic)',
    category: 'FOOD',
    counties: ['Example County'],
    contactMethod: syntheticPhone(10),
    contactMethodKind: 'PHONE',
    hours: 'Weekdays 9:00 to 16:00',
    cost: 'No cost',
    eligibility: 'Open to any veteran in the county; bring a photo ID if you have one.',
  },
  {
    serviceName: 'Sample Pantry Network (synthetic)',
    category: 'FOOD',
    counties: ['Sample County'],
    contactMethod: syntheticEmail('demo-pantry'),
    contactMethodKind: 'EMAIL',
    hours: 'Monday, Wednesday, Friday 10:00 to 14:00',
    cost: 'No cost',
    eligibility: 'Open to any veteran; household size is self-reported.',
  },
  {
    serviceName: 'Demo Ride Coordination (synthetic)',
    category: 'TRANSPORTATION',
    counties: ['Example County'],
    contactMethod: syntheticPhone(11),
    contactMethodKind: 'PHONE',
    hours: 'Weekdays 7:00 to 18:00',
    cost: 'No cost for eligible rides',
    eligibility: 'Veterans needing a ride to a scheduled appointment.',
  },
  {
    serviceName: 'Sample Mobility Desk (synthetic)',
    category: 'TRANSPORTATION',
    counties: ['Sample County'],
    contactMethod: 'Ask your responder to arrange',
    hours: 'Weekdays 8:00 to 17:00',
    cost: 'Varies by trip; responders confirm before booking',
    eligibility: 'Veterans with a confirmed appointment time.',
  },
  {
    serviceName: 'Demo Overnight Shelter (synthetic)',
    category: 'SHELTER',
    counties: ['Example County'],
    contactMethod: syntheticPhone(12),
    contactMethodKind: 'PHONE',
    hours: 'Check-in 17:00 to 20:00 daily',
    cost: 'No cost',
    eligibility: 'Temporary overnight shelter only, subject to space.',
  },
  {
    serviceName: 'Sample Temporary Shelter (synthetic)',
    category: 'SHELTER',
    counties: ['Sample County'],
    contactMethod: 'Ask your responder to arrange',
    hours: 'Intake 16:00 to 19:00 daily',
    cost: 'No cost',
    eligibility: 'Temporary shelter only, one night at a time, subject to space.',
  },
  {
    serviceName: 'Demo Peer Circle (synthetic)',
    category: 'PEER_SUPPORT',
    counties: ['Example County'],
    contactMethod: syntheticPhone(13),
    contactMethodKind: 'PHONE',
    hours: 'Tuesdays and Thursdays 18:00 to 19:30',
    cost: 'No cost',
    eligibility: 'Open to any veteran; drop in when you can.',
  },
  {
    serviceName: 'Sample Peer Line (synthetic)',
    category: 'PEER_SUPPORT',
    counties: ['Sample County'],
    contactMethod: 'Ask your responder to arrange',
    hours: 'Weekdays 12:00 to 15:00',
    cost: 'No cost',
    eligibility: 'Veterans looking to talk with another veteran.',
  },
];

const STATUS_ORDER: readonly ServiceRequestStatus[] = [
  'CREATED',
  'SUBMITTED',
  'TRIAGED',
  'MATCHING',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'FULFILLED',
  'CONFIRMED',
  'CLOSED',
  'CANCELLED',
];

function statusRank(status: ServiceRequestStatus): number {
  return STATUS_ORDER.indexOf(status);
}

/**
 * Run a sequence of domain commands against one Service Request, in order, returning the final
 * projection. When a step carries a `granteeId` (an ASSIGN), a disclosure guard confirms an active
 * consent grant exists for the assignee before the command is applied.
 */
async function advance(
  pool: Pool,
  sr: ServiceRequest,
  steps: readonly AdvanceStep[],
  actors: DemoActors,
): Promise<ServiceRequest> {
  let current = sr;
  for (const step of steps) {
    const actorId = step.actor === 'veteran' ? actors.veteranUserId : actors.responderUserId;
    const actorType = step.actor === 'veteran' ? 'VETERAN' : 'RESPONDER';
    const options =
      step.granteeId === undefined
        ? {}
        : {
            disclosureGuard: async (payload: {
              tenantId: string;
              serviceRequestId: string;
              caseId: string;
              granteeId: string;
            }): Promise<void> => {
              const grant = await findActiveGrant(pool, {
                tenantId: payload.tenantId,
                veteranUserId: actors.veteranUserId,
                permission: 'can_view',
                scope: 'current_requests',
                granteeType: 'RESPONDER',
                granteeId: payload.granteeId,
              });
              if (grant === undefined) {
                throw new Error('Demo seed: no active consent grant for the assignee.');
              }
            },
          };
    current = await executeServiceRequestCommand(
      pool,
      {
        tenantId: TENANT_ID,
        serviceRequestId: current.serviceRequestId,
        command: step.command,
        actorId,
        actorType,
        ...(step.reason !== undefined ? { reason: step.reason } : {}),
        ...(step.granteeId !== undefined ? { granteeId: step.granteeId } : {}),
      },
      options,
    );
  }
  return current;
}

async function createDemoServiceRequest(
  pool: Pool,
  caseId: string,
  category: ServiceRequest['category'],
  createdBy: string,
  details?: Record<string, string>,
): Promise<ServiceRequest> {
  return withTransaction(pool, (tx) =>
    createServiceRequest(tx, {
      tenantId: TENANT_ID,
      caseId,
      category,
      createdBy,
      actorType: 'VETERAN',
      ...(details !== undefined ? { details } : {}),
    }),
  );
}

/**
 * Ensure the demo Service Requests exist on the veteran's open case, keyed by category. Any
 * category that already has a request (in any status) is left untouched, which keeps the script
 * idempotent across re-runs.
 */
async function ensureDemoRequests(
  pool: Pool,
  caseId: string,
  veteran: SeedUser,
  responder: SeedUser,
): Promise<Record<string, { serviceRequestId: string; status: ServiceRequestStatus }>> {
  const existing = await listCaseServiceRequests(pool, TENANT_ID, caseId);
  const present = new Set<string>();
  for (const sr of existing) {
    present.add(sr.category);
  }

  const actors: DemoActors = {
    veteranUserId: veteran.userId,
    responderUserId: responder.userId,
  };

  if (!present.has('TRANSPORTATION')) {
    const created = await createDemoServiceRequest(pool, caseId, 'TRANSPORTATION', veteran.userId, {
      purpose: 'Ride to a scheduled appointment (synthetic)',
    });
    await advance(
      pool,
      created,
      [
        { command: 'SUBMIT', actor: 'veteran' },
        { command: 'TRIAGE', actor: 'responder' },
        { command: 'START_MATCHING', actor: 'responder' },
      ],
      actors,
    );
  }

  if (!present.has('FOOD')) {
    const created = await createDemoServiceRequest(pool, caseId, 'FOOD', veteran.userId, {
      note: 'Groceries for one week (synthetic)',
    });
    await advance(
      pool,
      created,
      [
        { command: 'SUBMIT', actor: 'veteran' },
        { command: 'TRIAGE', actor: 'responder' },
        { command: 'START_MATCHING', actor: 'responder' },
        { command: 'ASSIGN', actor: 'responder', granteeId: responder.userId },
        { command: 'ACCEPT', actor: 'responder' },
        { command: 'START', actor: 'responder' },
        { command: 'FULFILL', actor: 'responder' },
      ],
      actors,
    );
  }

  if (!present.has('SHELTER')) {
    const created = await createDemoServiceRequest(pool, caseId, 'SHELTER', veteran.userId);
    await advance(
      pool,
      created,
      [
        { command: 'SUBMIT', actor: 'veteran' },
        { command: 'CANCEL', actor: 'veteran', reason: 'Plans changed (synthetic demo).' },
      ],
      actors,
    );
  }

  const finalRequests = await listCaseServiceRequests(pool, TENANT_ID, caseId);
  const mostAdvanced = new Map<string, ServiceRequest>();
  for (const sr of finalRequests) {
    const current = mostAdvanced.get(sr.category);
    if (current === undefined || statusRank(sr.status) > statusRank(current.status)) {
      mostAdvanced.set(sr.category, sr);
    }
  }

  const result: Record<string, { serviceRequestId: string; status: ServiceRequestStatus }> = {};
  for (const [category, sr] of mostAdvanced) {
    result[category] = { serviceRequestId: sr.serviceRequestId, status: sr.status };
  }
  return result;
}

/**
 * Ensure the veteran has one COMPLETED Check-In. Existing COMPLETED rows win. Otherwise a Check-In
 * is started, every question is answered with its first option (the least-concerning answer, drawn
 * from the seeded questionnaire, never invented), and the Check-In is completed.
 */
async function ensureCompletedCheckIn(pool: Pool, veteran: SeedUser): Promise<string> {
  const existing = await pool.query<{ check_in_id: string }>(
    `SELECT check_in_id
       FROM check_ins
      WHERE tenant_id = $1
        AND veteran_user_id = $2
        AND status = 'COMPLETED'
      ORDER BY started_at DESC
      LIMIT 1`,
    [TENANT_ID, veteran.userId],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    return row.check_in_id;
  }

  const started = await startCheckIn(pool, {
    tenantId: TENANT_ID,
    veteranUserId: veteran.userId,
  });

  const questions = await listQuestionsWithOptions(pool, started.questionnaireVersion);
  for (const question of questions) {
    const option = question.options[0];
    if (option === undefined) {
      continue;
    }
    await saveResponse(pool, {
      tenantId: TENANT_ID,
      checkInId: started.checkInId,
      questionId: question.questionId,
      answerOptionId: option.answerOptionId,
    });
  }

  await completeCheckIn(pool, {
    tenantId: TENANT_ID,
    checkInId: started.checkInId,
    actorId: veteran.userId,
  });

  return started.checkInId;
}

/**
 * Ensure a Follow-Up addressed to the veteran exists on the case. Existing VETERAN-responsible rows
 * win, which keeps the script idempotent.
 */
async function ensureVeteranFollowUp(
  pool: Pool,
  caseId: string,
  veteran: SeedUser,
  responder: SeedUser,
): Promise<string> {
  const existing = await pool.query<{ follow_up_id: string }>(
    `SELECT follow_up_id
       FROM follow_ups
      WHERE tenant_id = $1
        AND case_id = $2
        AND responsible_type = 'VETERAN'
        AND responsible_id = $3
      LIMIT 1`,
    [TENANT_ID, caseId, veteran.userId],
  );
  const row = existing.rows[0];
  if (row !== undefined) {
    return row.follow_up_id;
  }

  const dueAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
  const created = await createFollowUp(pool, {
    tenantId: TENANT_ID,
    caseId,
    dueAt,
    responsibleType: 'VETERAN',
    responsibleId: veteran.userId,
    actorId: responder.userId,
    actorType: 'RESPONDER',
  });
  return created.followUpId;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  if (config.environment !== 'LOCAL') {
    throw new Error(`seed:demo refuses to run outside LOCAL (environment=${config.environment}).`);
  }
  assertSyntheticEnvironment(config);

  const pool = createPool(config);
  try {
    const base = await runLocalSeed(pool);

    // LOCAL demo only: re-seeding clears the sign-in rate-limit windows for the synthetic
    // example.invalid accounts, so a presenter is not locked out by the pilot limit of three
    // challenges per account per 15 minutes. Real destinations are never touched.
    await pool.query(`DELETE FROM auth_rate_limits WHERE subject LIKE '%@example.invalid'`);

    const demoResourceIds: string[] = [];
    for (const spec of DEMO_RESOURCES) {
      const resourceId = await ensureResource(pool, spec, base.admin.userId);
      demoResourceIds.push(resourceId);
    }

    const fresh = await getOrCreateUser(pool, 'veteran3');

    const caseId = base.qrf.supportCase.caseId;
    const serviceRequests = await ensureDemoRequests(pool, caseId, base.veteran, base.responder);
    const checkInId = await ensureCompletedCheckIn(pool, base.veteran);
    const followUpId = await ensureVeteranFollowUp(pool, caseId, base.veteran, base.responder);

    const veteranSession = await createSession(pool, config.sessionSecret, {
      tenantId: TENANT_ID,
      userId: base.veteran.userId,
    });

    const veteran3Session = await createSession(pool, config.sessionSecret, {
      tenantId: TENANT_ID,
      userId: fresh.userId,
    });

    const responderSession = await createSession(pool, config.sessionSecret, {
      tenantId: TENANT_ID,
      userId: base.responder.userId,
      organizationId: base.org.organizationId,
    });

    const adminSession = await withTransaction(pool, async (tx: PoolClient) => {
      const issued = await createSession(tx, config.sessionSecret, {
        tenantId: TENANT_ID,
        userId: base.admin.userId,
      });
      await elevateSession(tx, issued.session.sessionId);
      return issued;
    });

    const summary = {
      environment: config.environment,
      tenantId: TENANT_ID,
      demo: true,
      signIn: {
        method: 'EMAIL_OTP',
        veteranEmail: syntheticEmail('veteran'),
        freshVeteranEmail: syntheticEmail('veteran3'),
        codeSource: 'GET /api/v0/dev/last-challenge?destination=<email> (LOCAL only)',
      },
      users: {
        admin: { userId: base.admin.userId, email: base.admin.email ?? null },
        responder: { userId: base.responder.userId, email: base.responder.email ?? null },
        veteran: { userId: base.veteran.userId, email: base.veteran.email ?? null },
        veteran2: { userId: base.veteranTwo.userId, email: base.veteranTwo.email ?? null },
        veteran3: { userId: fresh.userId, email: fresh.email ?? null },
      },
      openCase: {
        caseId,
        serviceRequests,
      },
      checkInId,
      followUpId,
      settledCase: base.settled,
      consentGrantId: base.consentGrantId,
      trustedContactId: base.trustedContactId,
      notificationCount: base.notificationCount,
      resources: {
        baseCount: base.resourceIds.length,
        demoCount: demoResourceIds.length,
      },
      sessions: {
        veteranBearer: veteranSession.credential,
        veteran3Bearer: veteran3Session.credential,
        responderBearer: responderSession.credential,
        adminBearer: adminSession.credential,
      },
      chat: 'UNAVAILABLE: no released message store (SUAS-specs D033_CHAT_PARITY.md)',
    };

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
