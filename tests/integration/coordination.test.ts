/**
 * Coordination kernel integration evidence (requires PostgreSQL).
 *
 * SUAS-specs CASES.md §3.1 (atomic creation), §5 (atomic claim and assignment),
 * §7 (resolution), §9 (queue), §11 (critical suite: case transitions and
 * concurrency); DISPATCH.md §3, §6, §12; RESPONDER_WORKFLOWS.md §3, §4, §7, §12;
 * CONSENT.md §3.6, §3.8.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { listAggregateEvents } from '../../src/events/index.js';
import {
  addCaseNote,
  CaseAlreadyClaimedError,
  claimCase,
  ContactOutcomeRequiredError,
  createServiceRequest,
  createAssignmentVerifier,
  DisclosureGuardRequiredError,
  executeCaseCommand,
  executeServiceRequestCommand,
  findActiveAssignment,
  IllegalCaseTransitionError,
  listContactAttempts,
  NoActiveAssignmentError,
  NotAssignedError,
  openCase,
  recordContact,
  StaleCaseStateError,
} from '../../src/coordination/index.js';
import { createUser } from '../../src/identity/index.js';
import { evaluateDisclosure } from '../../src/consent/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function user(tenantId: string, label: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

async function scenario() {
  const tenantId = syntheticTenantId();
  const veteran = await user(tenantId, 'veteran');
  const responder = await user(tenantId, 'responder');
  const other = await user(tenantId, 'responder-b');
  const opened = await withTransaction(pool, (tx) =>
    openCase(tx, {
      tenantId,
      veteranUserId: veteran.userId,
      actorType: 'USER',
      actorId: responder.userId,
    }),
  );
  return { tenantId, veteran, responder, other, supportCase: opened.supportCase };
}

describe('CASES.md §3.1 — atomic creation invariant', () => {
  it('creates one case and emits CASE_CREATED once', async () => {
    const { tenantId, supportCase } = await scenario();
    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.filter((event) => event.eventType === 'CASE_CREATED')).toHaveLength(1);
  });

  it('resolves a duplicate open to the existing case rather than creating a second', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await user(tenantId, 'veteran');

    const first = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'SYSTEM',
        actorId: 'signal',
      }),
    );
    const second = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'SYSTEM',
        actorId: 'signal',
      }),
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.supportCase.caseId).toBe(first.supportCase.caseId);
  });

  it('yields one logical case under concurrent creation', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await user(tenantId, 'veteran');

    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        withTransaction(pool, (tx) =>
          openCase(tx, {
            tenantId,
            veteranUserId: veteran.userId,
            actorType: 'SYSTEM',
            actorId: 'signal',
          }),
        ),
      ),
    );

    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof openCase>>> =>
        attempt.status === 'fulfilled',
    );
    const created = fulfilled.filter((attempt) => attempt.value.created);
    expect(created).toHaveLength(1);

    const rows = await pool.query('SELECT case_id FROM support_cases WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(rows.rowCount).toBe(1);
  });

  it('permits a new case only once the previous one is closed', async () => {
    const { tenantId, veteran, responder, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
    });
    await executeCaseCommand(pool, {
      tenantId,
      caseId: supportCase.caseId,
      command: 'ACTIVATE',
      actorId: responder.userId,
      actorType: 'USER',
    });

    // A second non-closed case for the same veteran is refused while one is open.
    const blocked = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'USER',
        actorId: responder.userId,
      }),
    );
    expect(blocked.created).toBe(false);
  });
});

describe('CASES.md §5 — atomic claim', () => {
  it('assigns the case to the claiming responder', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    const result = await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
    });

    expect(result.supportCase.status).toBe('ASSIGNED');
    expect(result.assignment.acceptedByUserId).toBe(responder.userId);
  });

  it('produces exactly one winner under concurrent claims', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();

    const outcomes = await Promise.allSettled([
      claimCase(pool, { tenantId, caseId: supportCase.caseId, acceptedByUserId: responder.userId }),
      claimCase(pool, { tenantId, caseId: supportCase.caseId, acceptedByUserId: other.userId }),
      claimCase(pool, { tenantId, caseId: supportCase.caseId, acceptedByUserId: responder.userId }),
    ]);

    // CASES.md §5 item 5: the responder's repeated claim is a replay of the same
    // logical command, so it may also succeed, but only ever with the one
    // winning assignment.
    const winningIds = new Set(
      outcomes.flatMap((outcome) =>
        outcome.status === 'fulfilled' ? [outcome.value.assignment.caseAssignmentId] : [],
      ),
    );
    expect(winningIds.size).toBe(1);
    const otherWon = outcomes[1].status === 'fulfilled';
    const responderWon = outcomes[0].status === 'fulfilled' || outcomes[2].status === 'fulfilled';
    expect(otherWon !== responderWon).toBe(true);

    const assignments = await pool.query(
      `SELECT 1 FROM case_assignments WHERE case_id = $1 AND status = 'ACTIVE'`,
      [supportCase.caseId],
    );
    expect(assignments.rowCount).toBe(1);
  });

  it('emits CASE_ASSIGNED once per logical assignment', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    await Promise.allSettled([
      claimCase(pool, { tenantId, caseId: supportCase.caseId, acceptedByUserId: responder.userId }),
      claimCase(pool, { tenantId, caseId: supportCase.caseId, acceptedByUserId: other.userId }),
    ]);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.filter((event) => event.eventType === 'CASE_ASSIGNED')).toHaveLength(1);
  });

  it('replays a repeated claim by the holding responder with the original result', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    const first = await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
      expectedStatus: 'OPEN',
    });
    // Same logical command, same expectedStatus, after the case moved on.
    const again = await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
      expectedStatus: 'OPEN',
    });
    expect(again.assignment.caseAssignmentId).toBe(first.assignment.caseAssignmentId);
    expect(again.supportCase.status).toBe(first.supportCase.status);

    const assignments = await pool.query(`SELECT 1 FROM case_assignments WHERE case_id = $1`, [
      supportCase.caseId,
    ]);
    expect(assignments.rowCount).toBe(1);
    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.filter((event) => event.eventType === 'CASE_ASSIGNED')).toHaveLength(1);
  });

  it('conflicts when the case was already claimed, writing nothing', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
    });

    await expect(
      claimCase(pool, { tenantId, caseId: supportCase.caseId, acceptedByUserId: other.userId }),
    ).rejects.toThrow(CaseAlreadyClaimedError);

    const assignment = await findActiveAssignment(pool, supportCase.caseId);
    expect(assignment?.acceptedByUserId).toBe(responder.userId);
  });

  it('conflicts safely on a stale list item', async () => {
    const { tenantId, other, supportCase } = await scenario();
    await executeCaseCommand(pool, {
      tenantId,
      caseId: supportCase.caseId,
      command: 'TRIAGE',
      actorId: 'staff',
      actorType: 'SUAS_ADMIN',
    });

    // The claimer still believes the case is OPEN, as their list showed.
    await expect(
      claimCase(pool, {
        tenantId,
        caseId: supportCase.caseId,
        acceptedByUserId: other.userId,
        expectedStatus: 'OPEN',
      }),
    ).rejects.toThrow(StaleCaseStateError);
  });
});

describe('CASES.md §4.1 — unassigned cases cannot use assigned-responder edges', () => {
  it('refuses ESCALATE on an unassigned OPEN case', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await expect(
      executeCaseCommand(pool, {
        tenantId,
        caseId: supportCase.caseId,
        command: 'ESCALATE',
        actorId: responder.userId,
        actorType: 'USER',
        reason: 'urgent',
      }),
    ).rejects.toThrow(IllegalCaseTransitionError);
  });

  it('allows ESCALATE once assigned, and records the event', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
    });

    const escalated = await executeCaseCommand(pool, {
      tenantId,
      caseId: supportCase.caseId,
      command: 'ESCALATE',
      actorId: responder.userId,
      actorType: 'USER',
      reason: 'no responder available in region',
    });
    expect(escalated.status).toBe('ACTIVE');

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.some((event) => event.eventType === 'CASE_ESCALATED')).toBe(true);
  });

  it('refuses a responder who is not the assigned one', async () => {
    const { tenantId, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
    });

    await expect(
      executeCaseCommand(pool, {
        tenantId,
        caseId: supportCase.caseId,
        command: 'ACTIVATE',
        actorId: other.userId,
        actorType: 'USER',
      }),
    ).rejects.toThrow(NotAssignedError);
  });
});

describe('RESPONDER_WORKFLOWS.md §7 — contact log', () => {
  async function assignedCase() {
    const context = await scenario();
    await claimCase(pool, {
      tenantId: context.tenantId,
      caseId: context.supportCase.caseId,
      acceptedByUserId: context.responder.userId,
    });
    return context;
  }

  it('records a contact attempt and emits RESPONDER_CONTACT_LOGGED', async () => {
    const { tenantId, responder, supportCase } = await assignedCase();
    const result = await recordContact(pool, {
      tenantId,
      caseId: supportCase.caseId,
      loggedByUserId: responder.userId,
      command: 'log-contact-attempt',
      channel: 'PHONE',
      outcome: 'NO_ANSWER',
    });

    expect(result.deduplicated).toBe(false);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    const logged = events.find((event) => event.eventType === 'RESPONDER_CONTACT_LOGGED');
    expect(logged?.payload).toMatchObject({
      channel: 'PHONE',
      outcome: 'NO_ANSWER',
      command: 'log-contact-attempt',
      actor_id: responder.userId,
    });
  });

  it('requires an active assignment', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await expect(
      recordContact(pool, {
        tenantId,
        caseId: supportCase.caseId,
        loggedByUserId: responder.userId,
        command: 'log-contact-attempt',
        channel: 'PHONE',
        outcome: 'PENDING',
      }),
    ).rejects.toThrow(NoActiveAssignmentError);
  });

  it('refuses complete-contact with a PENDING outcome', async () => {
    const { tenantId, responder, supportCase } = await assignedCase();
    await expect(
      recordContact(pool, {
        tenantId,
        caseId: supportCase.caseId,
        loggedByUserId: responder.userId,
        command: 'complete-contact',
        channel: 'PHONE',
        outcome: 'PENDING',
      }),
    ).rejects.toThrow(ContactOutcomeRequiredError);
  });

  it('does not duplicate the contact fact when a command is replayed', async () => {
    const { tenantId, responder, supportCase } = await assignedCase();
    const input = {
      tenantId,
      caseId: supportCase.caseId,
      loggedByUserId: responder.userId,
      command: 'complete-contact' as const,
      channel: 'PHONE' as const,
      outcome: 'REACHED' as const,
      idempotencyKey: 'contact-command-1',
    };

    const first = await recordContact(pool, input);
    const replay = await recordContact(pool, input);

    expect(replay.deduplicated).toBe(true);
    expect(replay.contactAttempt.contactAttemptId).toBe(first.contactAttempt.contactAttemptId);
    expect(await listContactAttempts(pool, tenantId, supportCase.caseId)).toHaveLength(1);
  });

  it('does not emit RESPONDER_CONTACT_LOGGED for a Case Note', async () => {
    const { tenantId, responder, supportCase } = await assignedCase();
    await addCaseNote(pool, {
      tenantId,
      caseId: supportCase.caseId,
      authorUserId: responder.userId,
      body: 'Left a voicemail; will try again tomorrow.',
    });

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'SupportCase',
      aggregateId: supportCase.caseId,
    });
    expect(events.some((event) => event.eventType === 'RESPONDER_CONTACT_LOGGED')).toBe(false);
  });
});

describe('DISPATCH.md §3, §6, §8 — Service Request commands', () => {
  async function matchingRequest() {
    const context = await scenario();
    await claimCase(pool, {
      tenantId: context.tenantId,
      caseId: context.supportCase.caseId,
      acceptedByUserId: context.responder.userId,
    });
    const request = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId: context.tenantId,
        caseId: context.supportCase.caseId,
        category: 'TRANSPORTATION',
        createdBy: context.responder.userId,
        actorType: 'USER',
        details: { meeting_place: 'Main Street library' },
      }),
    );

    const base = {
      tenantId: context.tenantId,
      serviceRequestId: request.serviceRequestId,
      actorId: context.responder.userId,
      actorType: 'USER' as const,
    };
    await executeServiceRequestCommand(pool, { ...base, command: 'SUBMIT' });
    await executeServiceRequestCommand(pool, { ...base, command: 'TRIAGE' });
    await executeServiceRequestCommand(pool, { ...base, command: 'START_MATCHING' });
    return { ...context, request, base };
  }

  it('emits SERVICE_REQUEST_CREATED on creation', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    const request = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: supportCase.caseId,
        category: 'FOOD',
        createdBy: responder.userId,
        actorType: 'USER',
      }),
    );

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'ServiceRequest',
      aggregateId: request.serviceRequestId,
    });
    expect(events.map((event) => event.eventType)).toContain('SERVICE_REQUEST_CREATED');
  });

  it('refuses an externally disclosing assignment with no consent evaluation', async () => {
    const { base } = await matchingRequest();
    await expect(
      executeServiceRequestCommand(pool, { ...base, command: 'ASSIGN', granteeId: 'adapter-1' }),
    ).rejects.toThrow(DisclosureGuardRequiredError);
  });

  it('assigns when the disclosure guard allows it, and emits the event once', async () => {
    const { tenantId, base, request } = await matchingRequest();
    const seen: string[] = [];

    const assigned = await executeServiceRequestCommand(
      pool,
      { ...base, command: 'ASSIGN', granteeId: 'adapter-1' },
      {
        disclosureGuard: (params) => {
          seen.push(params.granteeId);
          return Promise.resolve();
        },
      },
    );

    expect(assigned.status).toBe('ASSIGNED');
    expect(seen).toEqual(['adapter-1']);

    const events = await listAggregateEvents(pool, {
      tenantId,
      aggregateType: 'ServiceRequest',
      aggregateId: request.serviceRequestId,
    });
    expect(events.filter((event) => event.eventType === 'SERVICE_REQUEST_ASSIGNED')).toHaveLength(
      1,
    );
  });

  it('re-evaluates disclosure on a reroute rather than reusing the prior decision', async () => {
    const { base } = await matchingRequest();
    const grantees: string[] = [];
    const guard = (params: { granteeId: string }) => {
      grantees.push(params.granteeId);
      return Promise.resolve();
    };

    await executeServiceRequestCommand(
      pool,
      { ...base, command: 'ASSIGN', granteeId: 'adapter-1' },
      { disclosureGuard: guard },
    );
    await executeServiceRequestCommand(pool, {
      ...base,
      command: 'DECLINE',
      reason: 'provider unavailable',
    });
    await executeServiceRequestCommand(pool, { ...base, command: 'REMATCH' });
    await executeServiceRequestCommand(
      pool,
      { ...base, command: 'ASSIGN', granteeId: 'adapter-2' },
      { disclosureGuard: guard },
    );

    // CONSENT.md §3.11: the new grantee gets its own decision.
    expect(grantees).toEqual(['adapter-1', 'adapter-2']);
  });

  it('produces one winner under concurrent assignment from MATCHING', async () => {
    const { base } = await matchingRequest();
    const guard = () => Promise.resolve();

    const outcomes = await Promise.allSettled([
      executeServiceRequestCommand(
        pool,
        { ...base, command: 'ASSIGN', granteeId: 'adapter-1' },
        { disclosureGuard: guard },
      ),
      executeServiceRequestCommand(
        pool,
        { ...base, command: 'ASSIGN', granteeId: 'adapter-2' },
        { disclosureGuard: guard },
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  });

  it('rejects an unknown category', async () => {
    const { tenantId, responder, supportCase } = await scenario();
    await expect(
      withTransaction(pool, (tx) =>
        createServiceRequest(tx, {
          tenantId,
          caseId: supportCase.caseId,
          category: 'HOUSING',
          createdBy: responder.userId,
          actorType: 'USER',
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('CONSENT.md §3.6 — the assignment verifier', () => {
  it('reports an active assignment for the assigned responder', async () => {
    const { tenantId, veteran, responder, other, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
    });

    const verify = createAssignmentVerifier(pool);
    expect(
      await verify({ tenantId, acceptedByUserId: responder.userId, veteranUserId: veteran.userId }),
    ).toBe(true);
    expect(
      await verify({ tenantId, acceptedByUserId: other.userId, veteranUserId: veteran.userId }),
    ).toBe(false);
  });

  it('lets the consent kernel grant responder access on that basis', async () => {
    const { tenantId, veteran, responder, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
    });

    // Slice 4 denied this basis for want of a verifier; Slice 5 supplies one.
    const decision = await evaluateDisclosure(
      pool,
      {
        tenantId,
        veteranUserId: veteran.userId,
        permission: 'can_view',
        scope: 'current_requests',
        granteeType: 'USER',
        granteeId: responder.userId,
        purpose: 'Coordinate an assigned case',
        systemBasis: 'CASE_ASSIGNMENT',
      },
      { verifyActiveAssignment: createAssignmentVerifier(pool) },
    );

    expect(decision).toMatchObject({ allowed: true, basis: 'CASE_ASSIGNMENT' });
  });

  it('denies once the assignment is released', async () => {
    const { tenantId, veteran, responder, supportCase } = await scenario();
    await claimCase(pool, {
      tenantId,
      caseId: supportCase.caseId,
      acceptedByUserId: responder.userId,
    });
    await pool.query(
      `UPDATE case_assignments SET status = 'RELEASED', released_at = now() WHERE case_id = $1`,
      [supportCase.caseId],
    );

    const decision = await evaluateDisclosure(
      pool,
      {
        tenantId,
        veteranUserId: veteran.userId,
        permission: 'can_view',
        scope: 'current_requests',
        granteeType: 'USER',
        granteeId: responder.userId,
        purpose: 'Coordinate a case I no longer hold',
        systemBasis: 'CASE_ASSIGNMENT',
      },
      { verifyActiveAssignment: createAssignmentVerifier(pool) },
    );

    expect(decision.allowed).toBe(false);
  });
});
