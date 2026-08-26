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
  findTrustedContact,
  inviteTrustedContact,
  listTrustedCircle,
  setTrustedContactStatus,
  type TrustedContact,
} from '../../consent/index.js';
import { API_PREFIX } from '../../release/pins.js';

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
}
