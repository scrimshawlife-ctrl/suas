/**
 * Notification logical sends.
 *
 * Spec citations:
 * - SUAS-specs NOTIFICATIONS.md §1 (durable, consent-aware logical sends), §3
 *   (one row is one logical send intent; duplicate generating delivery resolves
 *   to the same Notification; a deliberate reminder is a new identity), §4
 *   (evaluate at creation, re-evaluate immediately before each external attempt,
 *   revocation cancels, preferences never grant consent), §5 (durable execution;
 *   attempt history is immutable Audit Events; bounded retry; exhaustion is
 *   operationally visible), §6 (delivery status), §7 (templates carry no
 *   safety-critical decisions), §9 (attempt count is not a Follow-Up coordination
 *   count), §10 (privacy)
 * - SUAS-specs CONSENT.md §3.1-§3.3, §4 (revocation stops future use; in-flight
 *   jobs re-check before any not-yet-sent disclosure)
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  pageSize,
  takePage,
  type PageRequest,
  timestampText,
} from '../db/cursor.js';
import { evaluateDisclosure, type DisclosureRequest } from '../consent/index.js';
import type { DurableJobQueuePort } from '../jobs/index.js';
import {
  assertNotificationChannel,
  ChannelUnavailableError,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  type NotificationChannelPort,
  type OutboundMessage,
} from './channels.js';
import { buildNotificationSendPayload } from './send-job-payload.js';
import { renderEmailTemplate } from './templates.js';

export const DELIVERY_STATUSES = [
  'QUEUED',
  'SENT',
  'FAILED',
  'DELIVERED',
  'BOUNCED',
  'UNDELIVERABLE',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * States that represent a settled truth about this message.
 * NOTIFICATIONS.md §6: a duplicate or out-of-order webhook must not regress one.
 */
export const TERMINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = [
  'DELIVERED',
  'BOUNCED',
  'UNDELIVERABLE',
];

export interface Notification {
  readonly notificationId: string;
  readonly tenantId: string;
  readonly recipientUserId: string | undefined;
  readonly destination: string | undefined;
  readonly reason: string;
  readonly channel: NotificationChannel;
  readonly consentBasis: string;
  readonly templateVersion: string;
  readonly dedupeKey: string | undefined;
  /** Workflow entity this send is about, e.g. `ServiceRequest`. P-12. */
  readonly subjectType: string | undefined;
  readonly subjectId: string | undefined;
  readonly deliveryStatus: DeliveryStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly sentAt: Date | undefined;
  readonly cancelledAt: Date | undefined;
}

interface NotificationRow {
  notification_id: string;
  tenant_id: string;
  recipient_user_id: string | null;
  destination: string | null;
  reason: string;
  channel: NotificationChannel;
  consent_basis: string;
  template_version: string;
  dedupe_key: string | null;
  subject_type: string | null;
  subject_id: string | null;
  delivery_status: DeliveryStatus;
  attempt_count: number;
  max_attempts: number;
  sent_at: Date | null;
  cancelled_at: Date | null;
}

const NOTIFICATION_COLUMNS = `
  notification_id, tenant_id, recipient_user_id, destination, reason, channel,
  consent_basis, template_version, dedupe_key, subject_type, subject_id,
  delivery_status, attempt_count, max_attempts, sent_at, cancelled_at
`;

function toNotification(row: NotificationRow): Notification {
  return {
    notificationId: row.notification_id,
    tenantId: row.tenant_id,
    recipientUserId: row.recipient_user_id ?? undefined,
    destination: row.destination ?? undefined,
    reason: row.reason,
    channel: row.channel,
    consentBasis: row.consent_basis,
    templateVersion: row.template_version,
    dedupeKey: row.dedupe_key ?? undefined,
    subjectType: row.subject_type ?? undefined,
    subjectId: row.subject_id ?? undefined,
    deliveryStatus: row.delivery_status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    sentAt: row.sent_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
  };
}

export class NotificationConsentDeniedError extends Error {
  readonly code = 'CONSENT_DENIED';
  readonly httpStatus = 403;

  constructor() {
    super('No active consent or documented basis authorizes this notification.');
    this.name = 'NotificationConsentDeniedError';
  }
}

export class ChannelPreferenceDisabledError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(channel: NotificationChannel) {
    super(
      `The recipient has disabled the ${channel} channel. A preference selects an allowed ` +
        `channel; it never grants consent (SUAS-specs NOTIFICATIONS.md §4.4).`,
    );
    this.name = 'ChannelPreferenceDisabledError';
  }
}

export interface EnqueueNotificationInput {
  readonly tenantId: string;
  readonly recipientUserId?: string;
  readonly destination?: string;
  /** Notification policy key: why this send exists. */
  readonly reason: string;
  readonly channel: string;
  readonly templateVersion: string;
  /** Deterministic identity when the generating policy can be delivered twice. */
  readonly dedupeKey?: string;
  /**
   * Workflow entity this send is about (e.g. `ServiceRequest` + its id), so a
   * delivery can be joined back to the request/case/referral it concerns. P-12.
   */
  readonly subjectType?: string;
  readonly subjectId?: string;
  /**
   * The disclosure this send would make. Present when the recipient is a third
   * party; absent when the action discloses to nobody outside SUAS, in which case
   * the caller supplies the system basis through `disclosure.systemBasis`.
   */
  readonly disclosure: DisclosureRequest;
  readonly maxAttempts?: number;
  readonly correlationId?: string;
}

export interface EnqueueNotificationResult {
  readonly notification: Notification;
  /** True when a duplicate generating event resolved to the existing send. */
  readonly deduplicated: boolean;
}

/** NOTIFICATIONS.md §4.4: a preference selects a channel and grants nothing. */
export async function channelAllowedByPreference(
  db: Queryable,
  tenantId: string,
  userId: string | undefined,
  channel: NotificationChannel,
): Promise<boolean> {
  if (userId === undefined) return true;
  const result = await db.query<{ enabled: boolean }>(
    `SELECT enabled FROM notification_preferences
     WHERE tenant_id = $1 AND user_id = $2 AND channel = $3`,
    [tenantId, userId, channel],
  );
  // Absent preference means the channel is allowed; the row exists to opt out.
  return result.rows[0]?.enabled ?? true;
}

export async function setChannelPreference(
  db: Queryable,
  input: { tenantId: string; userId: string; channel: NotificationChannel; enabled: boolean },
): Promise<void> {
  await db.query(
    `INSERT INTO notification_preferences (tenant_id, user_id, channel, enabled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, user_id, channel)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
    [input.tenantId, input.userId, input.channel, input.enabled],
  );
}

/**
 * Effective preference per MVP channel. Absent rows mean allowed (opt-out model,
 * NOTIFICATIONS.md §4.4).
 */
export async function listChannelPreferences(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<readonly { channel: NotificationChannel; enabled: boolean }[]> {
  const result = await db.query<{ channel: NotificationChannel; enabled: boolean }>(
    `SELECT channel, enabled FROM notification_preferences
     WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  const byChannel = new Map(result.rows.map((row) => [row.channel, row.enabled] as const));
  return NOTIFICATION_CHANNELS.map((channel) => ({
    channel,
    enabled: byChannel.get(channel) ?? true,
  }));
}

/**
 * Create one logical send intent.
 *
 * NOTIFICATIONS.md §4.1: the basis is evaluated here, at creation. §4.2 requires
 * it to be evaluated again before the external attempt, because a grant can be
 * revoked in between — which is exactly the case §12 tests for.
 */
export async function enqueueNotification(
  pool: Pool,
  input: EnqueueNotificationInput,
  deps: { jobQueue?: DurableJobQueuePort } = {},
): Promise<EnqueueNotificationResult> {
  assertNotificationChannel(input.channel);
  const channel = input.channel;

  // A duplicate generating event resolves to the existing send before any
  // consent work, so a redelivered job cannot produce a second message (§3).
  if (input.dedupeKey !== undefined) {
    const existing = await findByDedupeKey(pool, input.tenantId, input.dedupeKey);
    if (existing !== undefined) return { notification: existing, deduplicated: true };
  }

  const decision = await evaluateDisclosure(pool, input.disclosure);
  if (!decision.allowed) throw new NotificationConsentDeniedError();

  if (!(await channelAllowedByPreference(pool, input.tenantId, input.recipientUserId, channel))) {
    throw new ChannelPreferenceDisabledError(channel);
  }

  const notificationId = randomUUID();
  const created = await withTransaction(pool, async (tx) => {
    const inserted = await tx.query<NotificationRow>(
      `INSERT INTO notifications
       (notification_id, tenant_id, recipient_user_id, destination, reason, channel,
        consent_basis, template_version, dedupe_key, subject_type, subject_id, max_attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING ${NOTIFICATION_COLUMNS}`,
      [
        notificationId,
        input.tenantId,
        input.recipientUserId ?? null,
        input.destination ?? null,
        input.reason,
        channel,
        decision.basis,
        input.templateVersion,
        input.dedupeKey ?? null,
        input.subjectType ?? null,
        input.subjectId ?? null,
        input.maxAttempts ?? 5,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) return undefined;
    // IN_APP is internal: the row is the inbox entry, so it is delivered as it is created,
    // with the attempt audit, and no send job or template is involved (NOTIFICATIONS.md §2, §6).
    if (channel !== 'IN_APP') return toNotification(row);
    const settled = await setStatus(tx, input.tenantId, notificationId, {
      status: 'SENT',
      attemptCount: 1,
      recordAttempt: true,
      sent: true,
    });
    await recordAttemptAudit(tx, settled, { outcome: 'SENT' });
    return settled;
  });

  if (created === undefined) {
    // Lost a concurrent race on the dedupe key.
    const existing =
      input.dedupeKey === undefined
        ? undefined
        : await findByDedupeKey(pool, input.tenantId, input.dedupeKey);
    if (existing === undefined) throw new Error('Notification insert produced no row.');
    return { notification: existing, deduplicated: true };
  }

  // NOTIFICATIONS.md §5: an external send is durable async work, enqueued where a
  // queue exists; otherwise the row waits for a worker to pick it up.
  if (deps.jobQueue !== undefined && channel !== 'IN_APP') {
    await deps.jobQueue.enqueue({
      jobType: 'notification.send',
      payload: buildNotificationSendPayload(notificationId, input.disclosure),
      idempotencyKey: notificationId,
      tenantId: input.tenantId,
    });
  }

  return { notification: created, deduplicated: false };
}

export interface SendAttemptResult {
  readonly notification: Notification;
  readonly outcome: 'SENT' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
  readonly reason?: string;
}

/**
 * EMAIL uses the versioned catalog (subject + text + html). SMS uses a text
 * body only — a caller-supplied renderer, or catalog text when the observed
 * reason/version key exists. IN_APP carries no body: the client renders it.
 */
function buildOutboundMessage(
  notification: Notification,
  destination: string,
  renderBody: ((notification: Notification) => string) | undefined,
): OutboundMessage {
  const base = {
    channel: notification.channel,
    destination,
    templateVersion: notification.templateVersion,
    idempotencyKey: notification.notificationId,
  } as const;

  if (notification.channel === 'EMAIL') {
    const rendered = renderEmailTemplate(notification.reason, notification.templateVersion, {
      ...(notification.subjectType !== undefined ? { subjectType: notification.subjectType } : {}),
    });
    return {
      ...base,
      subject: rendered.subject,
      body: rendered.text,
      html: rendered.html,
    };
  }

  if (renderBody !== undefined) {
    return { ...base, body: renderBody(notification) };
  }
  // IN_APP text is rendered by the client from the reason, so no catalog entry backs it.
  if (notification.channel === 'IN_APP') {
    return { ...base, body: '' };
  }

  // Shared observed keys may reuse catalog text without subject/html.
  const rendered = renderEmailTemplate(notification.reason, notification.templateVersion, {
    ...(notification.subjectType !== undefined ? { subjectType: notification.subjectType } : {}),
  });
  return { ...base, body: rendered.text };
}

/**
 * Attempt one external send.
 *
 * NOTIFICATIONS.md §4.2 and CONSENT.md §4: the basis is re-checked immediately
 * before the attempt. A grant revoked after enqueue cancels the send rather than
 * delivering it, which is the behavior §12 names first.
 */
export async function attemptSend(
  pool: Pool,
  channels: Map<NotificationChannel, NotificationChannelPort>,
  input: {
    tenantId: string;
    notificationId: string;
    disclosure: DisclosureRequest;
    /**
     * Text body for SMS (and optionally IN_APP). Ignored for EMAIL (versioned catalog).
     * An SMS without one falls back to catalog text and fails closed on a miss (§7).
     */
    renderBody?: (notification: Notification) => string;
  },
): Promise<SendAttemptResult> {
  const notification = await findNotification(pool, input.tenantId, input.notificationId);
  if (notification === undefined) throw new Error('No such Notification.');

  if (TERMINAL_DELIVERY_STATUSES.includes(notification.deliveryStatus)) {
    return { notification, outcome: 'SKIPPED', reason: 'ALREADY_TERMINAL' };
  }
  if (notification.deliveryStatus === 'SENT') {
    return { notification, outcome: 'SKIPPED', reason: 'ALREADY_SENT' };
  }
  if (notification.cancelledAt !== undefined) {
    return { notification, outcome: 'SKIPPED', reason: 'CANCELLED' };
  }

  // The re-check. This is the whole point of §4.2.
  const decision = await evaluateDisclosure(pool, input.disclosure);
  if (!decision.allowed) {
    const cancelled = await withTransaction(pool, async (tx) => {
      const updated = await setStatus(tx, input.tenantId, input.notificationId, {
        status: 'UNDELIVERABLE',
        cancelled: true,
        cancelReason: 'CONSENT_REVOKED_BEFORE_SEND',
      });
      await recordAttemptAudit(tx, notification, {
        outcome: 'CANCELLED',
        reason: 'CONSENT_REVOKED_BEFORE_SEND',
      });
      return updated;
    });
    return { notification: cancelled, outcome: 'CANCELLED', reason: 'CONSENT_REVOKED_BEFORE_SEND' };
  }

  const port = channels.get(notification.channel);
  if (port === undefined) {
    // NOTIFICATIONS.md §2: report unavailable; never record a send that did not
    // happen.
    throw new ChannelUnavailableError(notification.channel);
  }

  const destination = notification.destination ?? notification.recipientUserId;
  if (destination === undefined) {
    throw new Error('Notification has no destination or recipient.');
  }

  const acknowledgement = await port.send(
    buildOutboundMessage(notification, destination, input.renderBody),
  );

  return withTransaction(pool, async (tx) => {
    const attempts = notification.attemptCount + 1;
    const exhausted = attempts >= notification.maxAttempts;
    // §5: a refusal the adapter marks non-retryable (a permanent rejection, or an
    // ambiguous acknowledgement that must not be retried blindly) settles now.
    const settlesNow = exhausted || acknowledgement.retryable === false;

    const status: DeliveryStatus = acknowledgement.accepted
      ? 'SENT'
      : settlesNow
        ? 'UNDELIVERABLE'
        : 'FAILED';

    const updated = await setStatus(tx, input.tenantId, input.notificationId, {
      status,
      attemptCount: attempts,
      recordAttempt: true,
      ...(acknowledgement.accepted ? { sent: true } : {}),
    });

    // NOTIFICATIONS.md §5: every actual provider send attempt appends immutable
    // Audit Event history. There is deliberately no attempts table.
    await recordAttemptAudit(tx, updated, {
      outcome: acknowledgement.accepted ? 'SENT' : 'FAILED',
      ...(acknowledgement.failureReason !== undefined
        ? { reason: acknowledgement.failureReason }
        : {}),
      ...(acknowledgement.providerReference !== undefined
        ? { providerReference: acknowledgement.providerReference }
        : {}),
    });
    if (status === 'UNDELIVERABLE') {
      await recordUndeliverableAudit(
        tx,
        updated,
        acknowledgement.failureReason ?? 'attempts exhausted',
      );
    }

    return {
      notification: updated,
      outcome: acknowledgement.accepted ? ('SENT' as const) : ('FAILED' as const),
      ...(acknowledgement.failureReason !== undefined
        ? { reason: acknowledgement.failureReason }
        : {}),
    };
  });
}

export interface DeliveryCallbackInput {
  readonly tenantId: string;
  readonly notificationId: string;
  readonly providerEventId: string;
  readonly reportedStatus: DeliveryStatus;
  readonly reportedAt?: Date;
}

export interface DeliveryCallbackResult {
  readonly applied: boolean;
  readonly reason?: 'DUPLICATE' | 'WOULD_REGRESS_TERMINAL_STATE';
  readonly notification: Notification;
}

/**
 * Apply a provider delivery callback.
 *
 * NOTIFICATIONS.md §6: callbacks may move canonical delivery status after
 * authentication and deduplication, but a duplicate or out-of-order event must
 * not regress a terminal truthful state, and receipt never enqueues another
 * message.
 */
export async function applyDeliveryCallback(
  pool: Pool,
  input: DeliveryCallbackInput,
): Promise<DeliveryCallbackResult> {
  return withTransaction(pool, async (tx) => {
    const notification = await findNotification(tx, input.tenantId, input.notificationId);
    if (notification === undefined) throw new Error('No such Notification.');

    const claim = await tx.query(
      `INSERT INTO notification_delivery_callbacks
         (delivery_callback_id, tenant_id, notification_id, provider_event_id,
          reported_status, reported_at, applied, skip_reason)
       VALUES ($1, $2, $3, $4, $5, $6, false, NULL)
       ON CONFLICT (tenant_id, provider_event_id) DO NOTHING`,
      [
        randomUUID(),
        input.tenantId,
        input.notificationId,
        input.providerEventId,
        input.reportedStatus,
        input.reportedAt ?? null,
      ],
    );

    if ((claim.rowCount ?? 0) === 0) {
      return { applied: false, reason: 'DUPLICATE' as const, notification };
    }

    if (TERMINAL_DELIVERY_STATUSES.includes(notification.deliveryStatus)) {
      await tx.query(
        `UPDATE notification_delivery_callbacks
           SET skip_reason = 'WOULD_REGRESS_TERMINAL_STATE'
         WHERE tenant_id = $1 AND provider_event_id = $2`,
        [input.tenantId, input.providerEventId],
      );
      return {
        applied: false,
        reason: 'WOULD_REGRESS_TERMINAL_STATE' as const,
        notification,
      };
    }

    const updated = await setStatus(tx, input.tenantId, input.notificationId, {
      status: input.reportedStatus,
    });
    await tx.query(
      `UPDATE notification_delivery_callbacks SET applied = true
       WHERE tenant_id = $1 AND provider_event_id = $2`,
      [input.tenantId, input.providerEventId],
    );

    return { applied: true, notification: updated };
  });
}

async function setStatus(
  tx: Queryable,
  tenantId: string,
  notificationId: string,
  options: {
    status: DeliveryStatus;
    attemptCount?: number;
    recordAttempt?: boolean;
    sent?: boolean;
    cancelled?: boolean;
    cancelReason?: string;
  },
): Promise<Notification> {
  const result = await tx.query<NotificationRow>(
    `UPDATE notifications
       SET delivery_status = $3::suas_delivery_status,
           attempt_count = COALESCE($4, attempt_count),
           last_attempt_at = CASE WHEN $5::boolean THEN now() ELSE last_attempt_at END,
           sent_at = CASE WHEN $6::boolean THEN now() ELSE sent_at END,
           cancelled_at = CASE WHEN $7::boolean THEN now() ELSE cancelled_at END,
           cancel_reason = COALESCE($8, cancel_reason),
           updated_at = now()
     WHERE tenant_id = $1 AND notification_id = $2
     RETURNING ${NOTIFICATION_COLUMNS}`,
    [
      tenantId,
      notificationId,
      options.status,
      options.attemptCount ?? null,
      options.recordAttempt ?? false,
      options.sent ?? false,
      options.cancelled ?? false,
      options.cancelReason ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('No such Notification.');
  return toNotification(row);
}

async function recordAttemptAudit(
  tx: Queryable,
  notification: Notification,
  detail: { outcome: string; reason?: string; providerReference?: string },
): Promise<void> {
  await appendAuditEvent(tx, {
    eventType: 'NOTIFICATION_SEND_ATTEMPTED',
    action: 'ATTEMPT_NOTIFICATION_SEND',
    targetType: 'Notification',
    targetId: notification.notificationId,
    aggregateType: 'Notification',
    aggregateId: notification.notificationId,
    tenantId: notification.tenantId,
    actorType: 'SYSTEM',
    actorId: 'notifications',
    // NOTIFICATIONS.md §10: never the message body, and never the destination.
    payload: {
      channel: notification.channel,
      reason: notification.reason,
      outcome: detail.outcome,
      attempt_count: notification.attemptCount,
      consent_basis: notification.consentBasis,
      ...(detail.reason !== undefined ? { failure_reason: detail.reason } : {}),
      ...(detail.providerReference !== undefined
        ? { provider_reference: detail.providerReference }
        : {}),
    },
  });
}

export async function findNotification(
  db: Queryable,
  tenantId: string,
  notificationId: string,
): Promise<Notification | undefined> {
  const result = await db.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE tenant_id = $1 AND notification_id = $2`,
    [tenantId, notificationId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toNotification(row);
}

export async function findByDedupeKey(
  db: Queryable,
  tenantId: string,
  dedupeKey: string,
): Promise<Notification | undefined> {
  const result = await db.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE tenant_id = $1 AND dedupe_key = $2`,
    [tenantId, dedupeKey],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toNotification(row);
}

/**
 * Deliver IN_APP rows still `QUEUED`, which builds before IN_APP was settled at creation
 * left behind with no job to send them. Each row settles once, with its attempt audit.
 */
export async function deliverQueuedInApp(pool: Pool, limit = 100): Promise<number> {
  const queued = await pool.query<{ tenant_id: string; notification_id: string }>(
    `SELECT tenant_id, notification_id FROM notifications
     WHERE channel = 'IN_APP' AND delivery_status = 'QUEUED' AND cancelled_at IS NULL
     ORDER BY created_at
     LIMIT $1`,
    [limit],
  );
  let delivered = 0;
  for (const row of queued.rows) {
    const settled = await withTransaction(pool, async (tx) => {
      const updated = await tx.query<NotificationRow>(
        `UPDATE notifications
           SET delivery_status = 'SENT', attempt_count = attempt_count + 1,
               last_attempt_at = now(), sent_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND notification_id = $2 AND delivery_status = 'QUEUED'
         RETURNING ${NOTIFICATION_COLUMNS}`,
        [row.tenant_id, row.notification_id],
      );
      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) return false;
      await recordAttemptAudit(tx, toNotification(updatedRow), { outcome: 'SENT' });
      return true;
    });
    if (settled) delivered += 1;
  }
  return delivered;
}

/**
 * NOTIFICATIONS.md §5: a send whose job ran out of retries before any provider attempt
 * (channel unavailable, template error, bad payload) still settles `UNDELIVERABLE`, with
 * an audit, so it is not left `QUEUED`. A row already SENT or terminal is left alone.
 */
export async function settleUndeliverable(
  pool: Pool,
  input: { tenantId: string; notificationId: string; failureReason: string },
): Promise<Notification | undefined> {
  return withTransaction(pool, async (tx) => {
    const current = await tx.query<NotificationRow>(
      `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
       WHERE tenant_id = $1 AND notification_id = $2
       FOR UPDATE`,
      [input.tenantId, input.notificationId],
    );
    const row = current.rows[0];
    if (row === undefined) return undefined;
    if (row.delivery_status !== 'QUEUED' && row.delivery_status !== 'FAILED') return undefined;

    const updated = await setStatus(tx, input.tenantId, input.notificationId, {
      status: 'UNDELIVERABLE',
    });
    await recordUndeliverableAudit(tx, updated, input.failureReason);
    return updated;
  });
}

/** §5: an UNDELIVERABLE settlement is visible to operations, with its reason. */
async function recordUndeliverableAudit(
  tx: Queryable,
  notification: Notification,
  failureReason: string,
): Promise<void> {
  await appendAuditEvent(tx, {
    eventType: 'NOTIFICATION_UNDELIVERABLE',
    action: 'SETTLE_NOTIFICATION_UNDELIVERABLE',
    targetType: 'Notification',
    targetId: notification.notificationId,
    aggregateType: 'Notification',
    aggregateId: notification.notificationId,
    tenantId: notification.tenantId,
    actorType: 'SYSTEM',
    actorId: 'notifications',
    // §10: no body and no destination.
    payload: {
      channel: notification.channel,
      reason: notification.reason,
      attempt_count: notification.attemptCount,
      failure_reason: failureReason.slice(0, 300),
    },
  });
}

/** NOTIFICATIONS.md §5: exhausted delivery must be visible to operations. */
export async function listUndeliverable(
  db: Queryable,
  tenantId: string,
  limit = 50,
): Promise<Notification[]> {
  const result = await db.query<NotificationRow>(
    `SELECT ${NOTIFICATION_COLUMNS} FROM notifications
     WHERE tenant_id = $1 AND delivery_status = 'UNDELIVERABLE'
     ORDER BY updated_at DESC
     LIMIT $2`,
    [tenantId, Math.min(limit, 200)],
  );
  return result.rows.map(toNotification);
}

/**
 * Recipient-visible inbox. APIS.md: recipient reads own notifications only;
 * destinations and consent basis stay off the wire at the HTTP projection.
 */
export async function listNotificationsForRecipient(
  db: Queryable,
  tenantId: string,
  recipientUserId: string,
  limit = 50,
): Promise<Notification[]> {
  const page = await listRecipientNotificationPage(db, tenantId, recipientUserId, { limit });
  return page.notifications;
}

/**
 * The inbox as an API.md §5 keyset page, newest first by `created_at` (which, unlike
 * `updated_at`, never changes, so a delivery update cannot move a row across pages).
 */
export async function listRecipientNotificationPage(
  db: Queryable,
  tenantId: string,
  recipientUserId: string,
  page: PageRequest = {},
): Promise<{ notifications: Notification[]; nextCursor: string | undefined }> {
  const limit = pageSize(page.limit);
  const values: unknown[] = [tenantId, recipientUserId];
  let cursorCondition = '';
  if (page.cursor !== undefined) {
    const { at, id } = decodeTimeIdCursor(page.cursor);
    values.push(at, id);
    cursorCondition = 'AND (created_at, notification_id) < ($3::timestamptz, $4::uuid)';
  }
  values.push(limit + 1);
  const result = await db.query<NotificationRow & { created_at_key: string }>(
    `SELECT ${NOTIFICATION_COLUMNS}, ${timestampText('created_at')} AS created_at_key
     FROM notifications
     WHERE tenant_id = $1 AND recipient_user_id = $2 ${cursorCondition}
     ORDER BY created_at DESC, notification_id DESC
     LIMIT $${values.length}`,
    values,
  );
  const { rows, nextCursor } = takePage(result.rows, limit, (row) =>
    encodeTimeIdCursor({ at: row.created_at_key, id: row.notification_id }),
  );
  return { notifications: rows.map(toNotification), nextCursor };
}
