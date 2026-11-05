/**
 * Payload of the `notification.send` job.
 *
 * NOTIFICATIONS.md §4.2 requires the consent basis to be re-evaluated right
 * before each external attempt. The Notification row keeps only the basis that
 * was granted, not the disclosure that was evaluated, so the job carries that
 * disclosure: identifiers, enum values and field names only, never message
 * content or destinations (§10).
 */

import { z } from 'zod';
import {
  CONSENT_PERMISSIONS,
  CONSENT_SCOPES,
  GRANTEE_TYPES,
  SYSTEM_BASES,
  type DisclosureRequest,
} from '../consent/index.js';
import type { JsonObject } from '../jobs/port.js';

const disclosureSchema = z.object({
  tenantId: z.string().min(1),
  veteranUserId: z.string().min(1),
  permission: z.enum(CONSENT_PERMISSIONS),
  scope: z.enum(CONSENT_SCOPES),
  granteeType: z.enum(GRANTEE_TYPES),
  granteeId: z.string().min(1),
  purpose: z.string().min(1),
  systemBasis: z.enum(SYSTEM_BASES).optional(),
  disclosedFields: z.array(z.string()).optional(),
  correlationId: z.string().optional(),
  requestId: z.string().optional(),
});

const payloadSchema = z.object({
  notification_id: z.string().min(1),
  disclosure: disclosureSchema,
});

export interface NotificationSendJob {
  readonly notificationId: string;
  readonly disclosure: DisclosureRequest;
}

export function buildNotificationSendPayload(
  notificationId: string,
  disclosure: DisclosureRequest,
): JsonObject {
  return {
    notification_id: notificationId,
    // JSON round trip drops undefined optionals and yields plain JSON values.
    disclosure: JSON.parse(JSON.stringify(disclosure)) as JsonObject,
  };
}

/**
 * Returns undefined for any malformed payload, and for a disclosure whose tenant
 * differs from the job's tenant (tenant isolation survives jobs).
 */
export function parseNotificationSendPayload(
  payload: JsonObject,
  tenantId: string | undefined,
): NotificationSendJob | undefined {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success || tenantId === undefined) return undefined;
  const { disclosure } = parsed.data;
  if (disclosure.tenantId !== tenantId) return undefined;
  return {
    notificationId: parsed.data.notification_id,
    disclosure: {
      tenantId: disclosure.tenantId,
      veteranUserId: disclosure.veteranUserId,
      permission: disclosure.permission,
      scope: disclosure.scope,
      granteeType: disclosure.granteeType,
      granteeId: disclosure.granteeId,
      purpose: disclosure.purpose,
      ...(disclosure.systemBasis !== undefined ? { systemBasis: disclosure.systemBasis } : {}),
      ...(disclosure.disclosedFields !== undefined
        ? { disclosedFields: disclosure.disclosedFields }
        : {}),
      ...(disclosure.correlationId !== undefined
        ? { correlationId: disclosure.correlationId }
        : {}),
      ...(disclosure.requestId !== undefined ? { requestId: disclosure.requestId } : {}),
    },
  };
}
