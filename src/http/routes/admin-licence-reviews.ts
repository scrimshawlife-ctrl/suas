/**
 * SUAS Admin licence review routes (suas-specs R10.1, proposal; L5, L7.1–L7.3; ADMIN.md §2
 * as amended). Every route needs the SUAS Admin role and MFA elevation; every command is
 * audited and takes an Idempotency-Key. The idempotency record keeps only the review id
 * and state, and the page is re-read for each answer, so no licence field is stored there.
 * Images are served inline and never cached; there is no download.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { assertMfaElevated, assertSuasAdmin } from '../../authz/index.js';
import { commandScope, fingerprintRequest } from '../../idempotency/fingerprint.js';
import { runIdempotentCommand } from '../../idempotency/run.js';
import { LICENCE_IMAGE_SIDES } from '../../identity/licence-images.js';
import {
  approveReview,
  confirmReview,
  declineReview,
  listReviewQueue,
  QUEUE_DEFAULT_LIMIT,
  QUEUE_MAX_LIMIT,
  readReviewDetail,
  readReviewImage,
  recuseFromReview,
  revokeReview,
  type Checklist,
  type ReviewDetail,
} from '../../identity/licence-review-admin.js';
import { LicenceReviewNotFoundError } from '../../identity/licence-review.js';
import {
  LICENCE_DECLINE_REASONS,
  LICENCE_REVOKE_REASONS,
  type LicenceReview,
} from '../../identity/licence-review-store.js';
import { VeteranConfirmationUnavailableError } from '../../identity/va-confirmation.js';
import type { JsonObject } from '../../jobs/port.js';
import { API_PREFIX } from '../../release/pins.js';
import type { ObjectStoragePort } from '../../storage/index.js';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';

export interface AdminLicenceReviewRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  /** Absent when object storage is disabled; image and decision routes then answer 503. */
  readonly storage?: ObjectStoragePort;
}

const idParams = z.object({ id: z.string().uuid() });
const imageParams = z.object({ id: z.string().uuid(), side: z.enum(LICENCE_IMAGE_SIDES) });
const listQuery = z.object({
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(QUEUE_MAX_LIMIT).default(QUEUE_DEFAULT_LIMIT),
});
/** L5.2 and L5.3: the designation question and the by-eye checklist, all answered yes. */
const approvalBody = z
  .object({
    designation_visible: z.literal(true),
    checklist: z
      .object({
        selfie_matches: z.literal(true),
        security_features: z.literal(true),
        whole_card: z.literal(true),
      })
      .strict(),
  })
  .strict();
const declineBody = z.object({ reason: z.enum(LICENCE_DECLINE_REASONS) }).strict();
const revokeBody = z.object({ reason: z.enum(LICENCE_REVOKE_REASONS) }).strict();
const emptyBody = z.object({}).strict();

const iso = (value: Date | undefined) => value?.toISOString() ?? null;

/** The review page (L5.2–L5.3, L7.3). Never the subject's name, number or birth date. */
function adminReviewView(detail: ReviewDetail) {
  const { review, conflicting } = detail;
  return {
    review_id: review.reviewId,
    status: review.status,
    submitted_at: review.submittedAt.toISOString(),
    decided_at: iso(review.decidedAt),
    notice_version: review.noticeVersion,
    is_dispute: review.disputeOfReviewId !== undefined,
    dispute_of_review_id: review.disputeOfReviewId ?? null,
    images: review.images,
    reading:
      review.reading === undefined
        ? null
        : {
            fields: review.reading.fields,
            veteran: review.reading.veteran,
            consistency_checks: review.reading.checks,
          },
    identity_match: review.identityMatch ?? null,
    fingerprint_in_use: detail.fingerprintInUse,
    failure_class: review.failureClass ?? null,
    decline_reason: review.declineReason ?? null,
    revoke_reason: review.revokeReason ?? null,
    approved_by: review.approvedBy ?? null,
    approved_at: iso(review.approvedAt),
    confirmed_by: review.confirmedBy ?? null,
    confirmed_at: iso(review.confirmedAt),
    declined_by: review.declinedBy ?? null,
    revoked_by: review.revokedBy ?? null,
    viewer: {
      can_approve: detail.viewer.canApprove,
      can_confirm: detail.viewer.canConfirm,
      can_decline: detail.viewer.canDecline,
      can_revoke: detail.viewer.canRevoke,
    },
    conflicting_review:
      conflicting === undefined
        ? null
        : {
            review_id: conflicting.reviewId,
            status: conflicting.status,
            submitted_at: conflicting.submittedAt.toISOString(),
            decided_at: iso(conflicting.decidedAt),
            approved_by: conflicting.approvedBy ?? null,
            confirmed_by: conflicting.confirmedBy ?? null,
            identity_match: conflicting.identityMatch ?? null,
            notice_version: conflicting.noticeVersion,
          },
  };
}

const checklistOf = (body: z.infer<typeof approvalBody>): Checklist => ({
  selfieMatches: body.checklist.selfie_matches,
  securityFeatures: body.checklist.security_features,
  wholeCard: body.checklist.whole_card,
});

export function registerAdminLicenceReviewRoutes(
  app: FastifyInstance,
  deps: AdminLicenceReviewRouteDeps,
): void {
  const base = `${API_PREFIX}/admin/licence-reviews`;
  const gate = async (request: FastifyRequest, action: string) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertSuasAdmin(context);
    assertMfaElevated(context, action);
    return context;
  };
  const requireStorage = () => {
    if (deps.storage === undefined) throw new VeteranConfirmationUnavailableError();
    return deps.storage;
  };

  app.get(base, async (request) => {
    const context = await gate(request, 'Review licences');
    const query = listQuery.parse(request.query);
    const page = await listReviewQueue(deps.pool, {
      tenantId: context.tenantId,
      adminId: context.userId,
      limit: query.limit,
      cursor: query.cursor,
    });
    return {
      reviews: page.items.map((item) => ({
        review_id: item.reviewId,
        status: item.status,
        submitted_at: item.submittedAt.toISOString(),
        is_dispute: item.isDispute,
      })),
      limit: query.limit,
      next_cursor: page.nextCursor ?? null,
    };
  });

  app.get(`${base}/:id`, async (request) => {
    const context = await gate(request, 'Review licences');
    const params = idParams.safeParse(request.params);
    if (!params.success) throw new LicenceReviewNotFoundError();
    const detail = await readReviewDetail(deps.pool, {
      tenantId: context.tenantId,
      reviewId: params.data.id,
      adminId: context.userId,
    });
    return adminReviewView(detail);
  });

  /** L5.2: inline, never cached, no download. */
  app.get(`${base}/:id/images/:side`, async (request, reply) => {
    const context = await gate(request, 'Review licences');
    const params = imageParams.safeParse(request.params);
    if (!params.success) throw new LicenceReviewNotFoundError();
    const bytes = await readReviewImage(deps.pool, requireStorage(), {
      tenantId: context.tenantId,
      reviewId: params.data.id,
      adminId: context.userId,
      side: params.data.side,
    });
    if (bytes === undefined) throw new LicenceReviewNotFoundError();
    return reply
      .header('cache-control', 'no-store, private')
      .header('content-disposition', 'inline')
      .type('image/jpeg')
      .send(Buffer.from(bytes));
  });

  /**
   * One audited, idempotent command. The record keeps the id and state only; the answer is
   * the page read fresh, so a replay shows the current state.
   */
  const command = <B>(
    name: string,
    schema: z.ZodType<B>,
    run: (
      tx: Parameters<Parameters<typeof runIdempotentCommand>[2]>[0],
      input: { tenantId: string; reviewId: string; adminId: string; correlationId: string },
      body: B,
    ) => Promise<LicenceReview | undefined>,
  ) =>
    app.post(`${base}/:id/commands/${name}`, async (request, reply) => {
      const context = await gate(request, 'Decide licence reviews');
      const params = idParams.safeParse(request.params);
      if (!params.success) throw new LicenceReviewNotFoundError();
      const body = schema.parse(request.body ?? {});
      const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
      const input = {
        tenantId: context.tenantId,
        reviewId: params.data.id,
        adminId: context.userId,
        correlationId: String(request.id),
      };
      await runIdempotentCommand(
        deps.pool,
        {
          tenantId: context.tenantId,
          commandScope: commandScope({
            command: `POST /admin/licence-reviews/{id}/commands/${name}`,
            aggregateType: 'LicenceReview',
            aggregateId: input.reviewId,
            actorId: context.userId,
          }),
          idempotencyKey,
          requestFingerprint: fingerprintRequest({
            ...(body as JsonObject),
            actor_id: context.userId,
          }),
        },
        async (tx) => {
          const review = await run(tx, input, body);
          return {
            result: { review_id: input.reviewId, status: review?.status ?? null },
            aggregateType: 'LicenceReview',
            aggregateId: input.reviewId,
          };
        },
      );
      if (name === 'recuse') return reply.status(204).send();
      return adminReviewView(await readReviewDetail(deps.pool, input));
    });

  command('approve', approvalBody, (tx, input, body) =>
    approveReview(tx, { ...input, checklist: checklistOf(body) }),
  );
  command('confirm', approvalBody, (tx, input, body) =>
    confirmReview(tx, requireStorage(), { ...input, checklist: checklistOf(body) }),
  );
  command('decline', declineBody, (tx, input, body) =>
    declineReview(tx, requireStorage(), { ...input, reason: body.reason }),
  );
  command('recuse', emptyBody, async (tx, input) => {
    await recuseFromReview(tx, input);
    return undefined;
  });
  command('revoke', revokeBody, (tx, input, body) =>
    revokeReview(tx, { ...input, reason: body.reason }),
  );
}
