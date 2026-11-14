/**
 * Trusted Circle JSON surfaces for the authenticated veteran.
 *
 * Spec citations:
 * - SUAS-specs TRUSTED_CIRCLE.md §1–§3 (membership; invite; no implied consent)
 * - SUAS-specs APIS.md Plane A trusted-circle reads/commands
 * - SUAS-specs API.md §4 / PRIVACY.md (self roster only; no invite channel literals)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { enforceRateLimit } from '../../auth/index.js';
import {
  INVITE_LIMIT_PER_VETERAN,
  INVITE_LIMIT_PER_ADDRESS,
  INVITE_EMAIL_CAP_PER_RECIPIENT,
} from '../../consent/invite-limits.js';
import { normalizeDestination } from '../../auth/secrets.js';
import { ResourceNotVisibleError } from '../../authz/index.js';
import { requireVerifiedVeteran } from '../../identity/index.js';
import {
  acceptTrustedContact,
  auditTrustedContactTransition,
  findInviteEmail,
  findOpenInviteToAddress,
  findTrustedContact,
  inviteTrustedContact,
  listPendingInvitations,
  listTrustedCircle,
  setTrustedContactStatus,
  type TrustedContact,
} from '../../consent/index.js';
import { withTransaction } from '../../db/index.js';
import { appendDomainEvent } from '../../events/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import type { DurableJobQueuePort } from '../../jobs/index.js';
import { buildNotificationSendPayload, enqueueNotification } from '../../notifications/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { readIdempotencyKey } from '../idempotency-header.js';

export interface TrustedContactRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  /** Where present, the invite's `notification.send` job is enqueued at once. */
  readonly jobQueue?: DurableJobQueuePort;
}

export const TRUSTED_CONTACT_INVITE_REASON = 'trusted_contact_invited';
export const TRUSTED_CONTACT_INVITE_TEMPLATE_VERSION = 'invite@1';

/**
 * TRUSTED_CIRCLE.md §3.2: send the invite only to the email the Veteran gave; the
 * Notification records the template version. One send per invite (dedupe key), so a
 * replayed invite command repairs a send whose job was never enqueued and adds nothing
 * else. The email names nobody, so the basis is the Veteran's own request, not a grant.
 * A phone-only invite has no EMAIL to send (R9.4 is EMAIL only).
 */
async function deliverInvite(
  deps: TrustedContactRouteDeps,
  input: {
    tenantId: string;
    veteranUserId: string;
    trustedContactId: string;
    correlationId: string;
  },
): Promise<void> {
  const destination = await findInviteEmail(deps.pool, input.tenantId, input.trustedContactId);
  if (destination === undefined) return;
  const disclosure = {
    tenantId: input.tenantId,
    veteranUserId: input.veteranUserId,
    permission: 'can_view',
    scope: 'current_requests',
    granteeType: 'SYSTEM',
    granteeId: 'notifications',
    purpose: 'Send the Trusted Contact invite the Veteran asked for',
    systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
  } as const;
  // Admission and any suppression commit with the notification before a replay can see it.
  const { notification } = await enqueueNotification(deps.pool, {
    tenantId: input.tenantId,
    destination,
    reason: TRUSTED_CONTACT_INVITE_REASON,
    channel: 'EMAIL',
    templateVersion: TRUSTED_CONTACT_INVITE_TEMPLATE_VERSION,
    dedupeKey: `trusted-contact-invite:${input.trustedContactId}`,
    subjectType: 'TrustedContact',
    subjectId: input.trustedContactId,
    disclosure,
    correlationId: input.correlationId,
    recipientLimit: {
      policy: INVITE_EMAIL_CAP_PER_RECIPIENT,
      subject: `${input.tenantId}:${destination}`,
      failureReason: INVITE_EMAIL_SUPPRESSED,
    },
  });
  // Fresh, or a replay whose send job may never have been enqueued: the job is keyed by the
  // Notification, so enqueuing again is safe. Settled or suppressed rows need nothing.
  if (
    deps.jobQueue !== undefined &&
    notification.cancelledAt === undefined &&
    (notification.deliveryStatus === 'QUEUED' || notification.deliveryStatus === 'FAILED')
  ) {
    await deps.jobQueue.enqueue({
      jobType: 'notification.send',
      payload: buildNotificationSendPayload(notification.notificationId, disclosure),
      idempotencyKey: notification.notificationId,
      tenantId: input.tenantId,
    });
  }
}

/**
 * Each new invite sends an email, so invites are rate limited in the shared counter the
 * sign-in challenges use (AUTH.md §3; SECURITY.md §2). Implementation-owned values: no
 * released limit exists. Only committed invites count, since the counter is bumped in
 * the invite's transaction. Both counters depend on the caller's own invites only, so a
 * 429 never tells one Veteran that someone else invited the same address.
 */
export {
  INVITE_LIMIT_PER_VETERAN,
  INVITE_LIMIT_PER_ADDRESS,
  INVITE_EMAIL_CAP_PER_RECIPIENT,
} from '../../consent/invite-limits.js';

export const INVITE_EMAIL_SUPPRESSED = 'INVITE_RECIPIENT_CAP';

const idParams = z.object({ id: z.string().uuid() });

const inviteBody = z
  .object({
    relationship_label: z.string().min(1).max(128),
    invite_email: z.string().email().optional(),
    invite_phone: z.string().min(5).max(32).optional(),
  })
  .refine((body) => body.invite_email !== undefined || body.invite_phone !== undefined, {
    message: 'invite_email or invite_phone is required',
  });

function publicTrustedContact(contact: TrustedContact) {
  return {
    trusted_contact_id: contact.trustedContactId,
    relationship_label: contact.relationshipLabel,
    status: contact.status,
    contact_user_id: contact.contactUserId ?? null,
  };
}

export function registerTrustedContactRoutes(
  app: FastifyInstance,
  deps: TrustedContactRouteDeps,
): void {
  app.get(`${API_PREFIX}/trusted-contacts`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    const contacts = await listTrustedCircle(deps.pool, context.tenantId, context.userId);
    return { trusted_contacts: contacts.map(publicTrustedContact) };
  });

  /**
   * TRUSTED_CIRCLE.md §3.1, §3.4: create the invite, emit `TRUSTED_CONTACT_INVITED` and
   * audit it in one transaction. API.md §7: a retry with the same key replays the
   * first result instead of creating a second INVITED row.
   */
  app.post(`${API_PREFIX}/trusted-contacts`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    const body = inviteBody.parse(request.body);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      relationship_label: body.relationship_label,
      invite_email: body.invite_email ?? null,
      invite_phone: body.invite_phone ?? null,
      veteran_user_id: context.userId,
    });
    const scope = commandScope({
      command: 'POST /trusted-contacts',
      aggregateType: 'TrustedContact',
      actorId: context.userId,
    });

    let returnedOpenInvite = false;
    const run = await runIdempotentCommand(
      deps.pool,
      {
        tenantId: context.tenantId,
        commandScope: scope,
        idempotencyKey,
        requestFingerprint: fingerprint,
      },
      async (tx) => {
        const address = {
          tenantId: context.tenantId,
          veteranUserId: context.userId,
          ...(body.invite_email !== undefined ? { inviteEmail: body.invite_email } : {}),
          ...(body.invite_phone !== undefined ? { invitePhone: body.invite_phone } : {}),
        };
        // A second invite to an address this Veteran already invited returns that invite;
        // its email was sent once and is not sent again.
        const open = await findOpenInviteToAddress(tx, address);
        if (open !== undefined) {
          returnedOpenInvite = true;
          return {
            result: publicTrustedContact(open),
            aggregateType: 'TrustedContact',
            aggregateId: open.trustedContactId,
          };
        }
        await enforceRateLimit(
          tx,
          INVITE_LIMIT_PER_VETERAN,
          `${context.tenantId}:${context.userId}`,
        );
        for (const destination of [body.invite_email, body.invite_phone]) {
          if (destination !== undefined) {
            await enforceRateLimit(
              tx,
              INVITE_LIMIT_PER_ADDRESS,
              `${context.tenantId}:${context.userId}:${normalizeDestination(destination)}`,
            );
          }
        }
        const contact = await inviteTrustedContact(tx, {
          tenantId: context.tenantId,
          veteranUserId: context.userId,
          relationshipLabel: body.relationship_label,
          ...(body.invite_email !== undefined ? { inviteEmail: body.invite_email } : {}),
          ...(body.invite_phone !== undefined ? { invitePhone: body.invite_phone } : {}),
        });
        const appended = await appendDomainEvent(tx, {
          eventType: 'TRUSTED_CONTACT_INVITED',
          aggregateType: 'TrustedContact',
          aggregateId: contact.trustedContactId,
          tenantId: context.tenantId,
          actorType: 'VETERAN',
          actorId: context.userId,
          // Channels only: the invite addresses stay on the row (PRIVACY.md).
          payload: {
            status: contact.status,
            channels: [
              ...(body.invite_email !== undefined ? ['EMAIL'] : []),
              ...(body.invite_phone !== undefined ? ['SMS'] : []),
            ],
          },
          idempotencyKey: `trusted-contact-invited:${contact.trustedContactId}`,
          correlationId: String(request.id),
        });
        await auditTrustedContactTransition(tx, {
          contact,
          transition: 'INVITE',
          actorType: 'VETERAN',
          actorId: context.userId,
          correlationId: String(request.id),
        });
        return {
          result: publicTrustedContact(contact),
          aggregateType: 'TrustedContact',
          aggregateId: contact.trustedContactId,
          eventId: appended.event.eventId,
        };
      },
    );

    // After the commit, so the send never names a row that rolled back.
    const trustedContactId = run.result.trusted_contact_id;
    if (typeof trustedContactId === 'string') {
      await deliverInvite(deps, {
        tenantId: context.tenantId,
        veteranUserId: context.userId,
        trustedContactId,
        correlationId: String(request.id),
      });
    }
    if (!run.replayed) {
      return reply.status(returnedOpenInvite ? 200 : 201).send({ ...run.result, replayed: false });
    }
    return { ...run.result, replayed: true };
  });

  /**
   * R9.4 (contributor proposal, specs #72): the invites waiting for the caller, matched on
   * their enrolled email, with the inviting Veteran's display name and the relationship
   * label only. Accepting goes through the accept command below.
   */
  app.get(`${API_PREFIX}/trusted-contacts/invitations`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const invitations = await listPendingInvitations(deps.pool, context.tenantId, context.userId);
    return {
      invitations: invitations.map((invitation) => ({
        trusted_contact_id: invitation.trustedContactId,
        veteran_display_name: invitation.veteranDisplayName ?? null,
        relationship_label: invitation.relationshipLabel,
      })),
    };
  });

  app.post(`${API_PREFIX}/trusted-contacts/:id/commands/remove`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    const { id } = idParams.parse(request.params);
    const existing = await findTrustedContact(deps.pool, context.tenantId, id);
    if (existing === undefined || existing.veteranUserId !== context.userId) {
      throw new ResourceNotVisibleError();
    }
    const updated = await withTransaction(deps.pool, async (tx) => {
      const removed = await setTrustedContactStatus(tx, context.tenantId, id, 'REMOVED');
      if (removed === undefined) throw new ResourceNotVisibleError();
      // TRUSTED_CIRCLE.md §7: the transition is audited with the change itself.
      await auditTrustedContactTransition(tx, {
        contact: removed,
        transition: 'REMOVE',
        actorType: 'VETERAN',
        actorId: context.userId,
        correlationId: String(request.id),
      });
      return removed;
    });
    return publicTrustedContact(updated);
  });

  /**
   * TRUSTED_CIRCLE.md §3.3–§3.4: the invitee accepts; acceptance grants no consent.
   * The actor becomes `contact_user_id` only when their enrolled address is the invited
   * one; anyone else gets the same 404 as an unknown id. Veterans cannot accept their own.
   */
  app.post(`${API_PREFIX}/trusted-contacts/:id/commands/accept`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const existing = await findTrustedContact(deps.pool, context.tenantId, id);
    if (existing === undefined) throw new ResourceNotVisibleError();
    if (existing.veteranUserId === context.userId) {
      throw new ResourceNotVisibleError();
    }
    if (existing.status !== 'INVITED') {
      // Already accepted/terminal — hide as not found rather than leaking state
      // across actors who should not see the invite.
      if (existing.contactUserId !== undefined && existing.contactUserId !== context.userId) {
        throw new ResourceNotVisibleError();
      }
    }

    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      trusted_contact_id: id,
      contact_user_id: context.userId,
      command: 'accept',
    });
    const scope = commandScope({
      command: 'POST /trusted-contacts/{id}/commands/accept',
      aggregateType: 'TrustedContact',
      aggregateId: id,
      actorId: context.userId,
    });

    const run = await runIdempotentCommand(
      deps.pool,
      {
        tenantId: context.tenantId,
        commandScope: scope,
        idempotencyKey,
        requestFingerprint: fingerprint,
      },
      async (tx) => {
        const current = await findTrustedContact(tx, context.tenantId, id);
        if (current === undefined || current.veteranUserId === context.userId) {
          throw new ResourceNotVisibleError();
        }
        const accepted = await acceptTrustedContact(tx, context.tenantId, id, context.userId);
        if (accepted === undefined) {
          // Not INVITED anymore — return current if this actor is bound, else 404.
          if (current.contactUserId === context.userId) {
            return {
              result: publicTrustedContact(current),
              aggregateType: 'TrustedContact',
              aggregateId: id,
            };
          }
          throw new ResourceNotVisibleError();
        }
        await auditTrustedContactTransition(tx, {
          contact: accepted,
          transition: 'ACCEPT',
          actorType: 'TRUSTED_CONTACT',
          actorId: context.userId,
          correlationId: String(request.id),
        });
        return {
          result: publicTrustedContact(accepted),
          aggregateType: 'TrustedContact',
          aggregateId: id,
        };
      },
    );

    return { ...run.result, replayed: run.replayed };
  });
}
