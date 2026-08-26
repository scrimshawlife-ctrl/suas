/**
 * Recipient notification inbox and channel preferences.
 *
 * Spec citations:
 * - SUAS-specs APIS.md notifications rows (no public send)
 * - SUAS-specs NOTIFICATIONS.md §4 (preferences never grant consent), §10
 * - SUAS-specs API.md §4 / PRIVACY.md (recipient-owned; no destinations)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { API_PREFIX } from '../../release/pins.js';
import {
  listNotificationsForRecipient,
  NOTIFICATION_CHANNELS,
  setChannelPreference,
  type Notification,
} from '../../notifications/index.js';

export interface NotificationRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const preferenceBody = z.object({
  channel: z.enum(NOTIFICATION_CHANNELS),
  enabled: z.boolean(),
});

function publicNotification(notification: Notification) {
  return {
    notification_id: notification.notificationId,
    reason: notification.reason,
    channel: notification.channel,
    delivery_status: notification.deliveryStatus,
    attempt_count: notification.attemptCount,
    subject_type: notification.subjectType ?? null,
    subject_id: notification.subjectId ?? null,
    sent_at: notification.sentAt?.toISOString() ?? null,
    cancelled_at: notification.cancelledAt?.toISOString() ?? null,
  };
}

export function registerNotificationRoutes(
  app: FastifyInstance,
  deps: NotificationRouteDeps,
): void {
  app.get(`${API_PREFIX}/notifications`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const query = listQuery.parse(request.query);
    const page = await listNotificationsForRecipient(
      deps.pool,
      context.tenantId,
      context.userId,
      query.limit,
    );
    return {
      notifications: page.map(publicNotification),
      limit: query.limit,
    };
  });

  app.put(`${API_PREFIX}/notifications/preferences`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const body = preferenceBody.parse(request.body);
    await setChannelPreference(deps.pool, {
      tenantId: context.tenantId,
      userId: context.userId,
      channel: body.channel,
      enabled: body.enabled,
    });
    return {
      channel: body.channel,
      enabled: body.enabled,
    };
  });
}
