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
import { ResourceNotVisibleError } from '../../authz/index.js';
import {
  acceptTrustedContact,
  findTrustedContact,
  inviteTrustedContact,
  listTrustedCircle,
  setTrustedContactStatus,
  type TrustedContact,
} from '../../consent/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { readIdempotencyKey } from '../idempotency-header.js';

export interface TrustedContactRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

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
    const contacts = await listTrustedCircle(deps.pool, context.tenantId, context.userId);
    return { trusted_contacts: contacts.map(publicTrustedContact) };
  });

  app.post(`${API_PREFIX}/trusted-contacts`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const body = inviteBody.parse(request.body);
    const contact = await inviteTrustedContact(deps.pool, {
      tenantId: context.tenantId,
      veteranUserId: context.userId,
      relationshipLabel: body.relationship_label,
      ...(body.invite_email !== undefined ? { inviteEmail: body.invite_email } : {}),
      ...(body.invite_phone !== undefined ? { invitePhone: body.invite_phone } : {}),
    });
    return reply.status(201).send(publicTrustedContact(contact));
  });

  app.post(`${API_PREFIX}/trusted-contacts/:id/commands/remove`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const existing = await findTrustedContact(deps.pool, context.tenantId, id);
    if (existing === undefined || existing.veteranUserId !== context.userId) {
      throw new ResourceNotVisibleError();
    }
    const updated = await setTrustedContactStatus(deps.pool, context.tenantId, id, 'REMOVED');
    if (updated === undefined) throw new ResourceNotVisibleError();
    return publicTrustedContact(updated);
  });

  /**
   * TRUSTED_CIRCLE.md §3.4: the invitee accepts; acceptance does not grant consent.
   * The authenticated actor becomes `contact_user_id`. Veterans cannot accept
   * their own invites.
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
