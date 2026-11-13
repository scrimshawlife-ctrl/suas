/**
 * The Veteran's licence review routes (suas-specs R10.1, proposal; L1, L2, L6, L7.3).
 *
 * Any signed-in person may call them; whether the path is offered is decided by the VA
 * answer. Responses carry states, reasons and times only, never a licence field, and a
 * validation error names the field, never its content. The session is checked before the
 * upload body is read.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { AuthContext } from '../../authz/index.js';
import {
  LICENCE_IMAGE_SIDES,
  LICENCE_MAX_IMAGE_BYTES,
  type LicenceImageSet,
} from '../../identity/licence-images.js';
import {
  isDisputable,
  isLicencePathOpen,
  LICENCE_NOTICE_V1,
  LicenceImageInputError,
  licenceEligibility,
  LicenceReviewNotFoundError,
  submitLicence,
} from '../../identity/licence-review.js';
import { findNewestReview, type LicenceReview } from '../../identity/licence-review-store.js';
import { readVeteranConfirmation } from '../../identity/va-confirmation-store.js';
import { VeteranConfirmationUnavailableError } from '../../identity/va-confirmation.js';
import type { DurableJobQueuePort } from '../../jobs/index.js';
import { API_PREFIX } from '../../release/pins.js';
import type { ObjectStoragePort } from '../../storage/index.js';
import { authenticate } from '../authenticate.js';

export interface LicenceReviewRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  /** False when SUAS_LICENCE_READER_MODE=disabled; the path is then closed (503). */
  readonly readerConfigured: boolean;
  readonly storage?: ObjectStoragePort;
  readonly jobQueue?: DurableJobQueuePort;
}

/**
 * Three base64 images of at most 1,000,000 bytes each plus the notice: about 4.1 MB, under
 * the 6 MB Lambda request limit with room for the event around it.
 */
export const LICENCE_BODY_LIMIT_BYTES = 4_500_000;
const MAX_BASE64_CHARS = Math.ceil(LICENCE_MAX_IMAGE_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const imageSchema = z
  .object({
    content_type: z.literal('image/jpeg'),
    data_base64: z.string().min(4).max(MAX_BASE64_CHARS).regex(BASE64),
  })
  .strict();
const submitSchema = z
  .object({
    notice_version: z.unknown(),
    front: imageSchema,
    back: imageSchema,
    selfie: imageSchema,
  })
  .strict();
const reviewParams = z.object({ review_id: z.string().uuid() });

/** The images, or a 400 naming the fields that failed (the last L2.3 check). */
function parseImages(body: unknown): LicenceImageSet {
  const parsed = submitSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) =>
      issue.code === 'unrecognized_keys' ? 'unknown fields' : String(issue.path[0] ?? 'body'),
    );
    throw new LicenceImageInputError([...new Set(fields)]);
  }
  const out: Partial<Record<(typeof LICENCE_IMAGE_SIDES)[number], Uint8Array>> = {};
  const failed: string[] = [];
  for (const side of LICENCE_IMAGE_SIDES) {
    const data = parsed.data[side].data_base64;
    if (data.length % 4 !== 0) failed.push(side);
    else out[side] = new Uint8Array(Buffer.from(data, 'base64'));
  }
  if (failed.length > 0) throw new LicenceImageInputError(failed);
  return out as LicenceImageSet;
}

const noticeOf = (body: unknown): unknown =>
  typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).notice_version
    : undefined;

/** What the Veteran sees about a review: states, codes and times only. */
export function licenceReviewView(review: LicenceReview, disputable: boolean) {
  return {
    review_id: review.reviewId,
    status: review.status,
    decline_reason: review.declineReason ?? null,
    failure_class: review.failureClass ?? null,
    disputable,
    dispute_of_review_id: review.disputeOfReviewId ?? null,
    submitted_at: review.submittedAt.toISOString(),
    decided_at: review.decidedAt?.toISOString() ?? null,
  };
}

export function registerLicenceReviewRoutes(
  app: FastifyInstance,
  deps: LicenceReviewRouteDeps,
): void {
  const path = `${API_PREFIX}/veterans/me/verification/licence`;
  const configured =
    deps.readerConfigured && deps.storage !== undefined && deps.jobQueue !== undefined;

  /** L1.3, L4.6, L6: whether the path is offered now, and the newest review. */
  app.get(path, async (request) => {
    const { tenantId, userId } = await authenticate(deps.pool, deps.sessionSecret, request);
    const open = await isLicencePathOpen(deps.pool, configured);
    const offered = open && (await licenceEligibility(deps.pool, tenantId, userId)) !== undefined;
    const review = await findNewestReview(deps.pool, tenantId, userId);
    const revoked =
      (await readVeteranConfirmation(deps.pool, tenantId, userId))?.status === 'REVOKED';
    return {
      offered,
      notice_version: LICENCE_NOTICE_V1,
      review:
        review === undefined
          ? null
          : licenceReviewView(review, open && !revoked && isDisputable(review)),
    };
  });

  // The session is checked in onRequest, before the up-to-4.5 MB body is read or parsed.
  const contexts = new WeakMap<FastifyRequest, AuthContext>();
  const signedIn = async (request: FastifyRequest) => {
    contexts.set(request, await authenticate(deps.pool, deps.sessionSecret, request));
  };
  const send = async (request: FastifyRequest, disputeOfReviewId: string | undefined) => {
    const context =
      contexts.get(request) ?? (await authenticate(deps.pool, deps.sessionSecret, request));
    const { storage, jobQueue } = deps;
    if (!configured || storage === undefined || jobQueue === undefined) {
      throw new VeteranConfirmationUnavailableError();
    }
    const review = await submitLicence(
      { pool: deps.pool, storage, jobQueue, readerConfigured: true },
      {
        tenantId: context.tenantId,
        userId: context.userId,
        noticeVersion: noticeOf(request.body),
        images: () => parseImages(request.body),
        ...(disputeOfReviewId !== undefined ? { disputeOfReviewId } : {}),
        correlationId: String(request.id),
      },
    );
    return licenceReviewView(review, false);
  };
  const options = { bodyLimit: LICENCE_BODY_LIMIT_BYTES, onRequest: signedIn };

  /** L2.3: checks in order, stores the re-encoded images and answers 202 with the state. */
  app.post(path, options, async (request, reply) =>
    reply.status(202).send(await send(request, undefined)),
  );

  /** L7.3: a new review that disputes an ALREADY_USED decline, with new images. */
  app.post(`${path}/:review_id/commands/dispute`, options, async (request, reply) => {
    const params = reviewParams.safeParse(request.params);
    if (!params.success) throw new LicenceReviewNotFoundError();
    return reply.status(202).send(await send(request, params.data.review_id));
  });
}
