/**
 * Startup check on the approved VA projection (suas-specs #72 VA_CONFIRMATION_FLOW §3,
 * amendment A27; D035_VA_CONFIRMATION_ADAPTER.md §7 "NO_REQUEST_UNTIL ... Privacy Owner
 * approved"). `sandbox` mode starts only when the SHA-256 of the projection file equals
 * `projection_sha256` in the approval record and that record is APPROVED. `fixture` and
 * `disabled` send nothing to VA and skip it.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { VA_CONFIRMATION_PROJECTION_ID } from './va-confirmation.js';
import { VA_PROJECTION_APPROVAL_TEXT, VA_PROJECTION_FILE_TEXT } from './va-projection-artifact.js';

/** The projection file and its approval record, each as the exact file text. */
export interface VaProjectionArtifact {
  readonly projectionText: string;
  readonly approvalText: string;
}

/** The copies vendored from suas-specs under contract/va-projection/. */
export const VENDORED_VA_PROJECTION: VaProjectionArtifact = {
  projectionText: VA_PROJECTION_FILE_TEXT,
  approvalText: VA_PROJECTION_APPROVAL_TEXT,
};

/** The spec does not name the approved status yet; anything else counts as not approved. */
export const VA_PROJECTION_APPROVED_STATUS = 'APPROVED';

const approvalSchema = z.object({
  projection_id: z.string(),
  projection_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.string(),
  approved_by: z.string().nullable(),
  approval_timestamp: z.string().nullable(),
});
const projectionSchema = z.object({ projection_id: z.string() });

export class VaProjectionNotApprovedError extends Error {
  constructor(reason: string) {
    super(`SUAS_VA_CONFIRMATION_MODE=sandbox refused: ${reason}`);
    this.name = 'VaProjectionNotApprovedError';
  }
}

/** SHA-256 of the projection file bytes (UTF-8), as the approval record states it. */
export const projectionSha256 = (projectionText: string): string =>
  createHash('sha256').update(projectionText, 'utf8').digest('hex');

/** Throws unless the projection is the released one, unchanged, and approved. */
export function assertVaProjectionApproved(
  artifact: VaProjectionArtifact = VENDORED_VA_PROJECTION,
): void {
  const parse = <T>(schema: z.ZodType<T>, text: string, what: string): T => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new VaProjectionNotApprovedError(`the ${what} is not valid JSON.`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new VaProjectionNotApprovedError(`the ${what} is malformed.`);
    return parsed.data;
  };
  const approval = parse(approvalSchema, artifact.approvalText, 'projection approval record');
  const projection = parse(projectionSchema, artifact.projectionText, 'projection file');

  for (const id of [approval.projection_id, projection.projection_id]) {
    if (id !== VA_CONFIRMATION_PROJECTION_ID) {
      throw new VaProjectionNotApprovedError(
        `the projection is ${id}, not ${VA_CONFIRMATION_PROJECTION_ID}.`,
      );
    }
  }
  if (projectionSha256(artifact.projectionText) !== approval.projection_sha256) {
    throw new VaProjectionNotApprovedError(
      'the projection file does not match projection_sha256 in its approval record.',
    );
  }
  if (
    approval.status !== VA_PROJECTION_APPROVED_STATUS ||
    approval.approved_by === null ||
    approval.approval_timestamp === null
  ) {
    throw new VaProjectionNotApprovedError(
      `the Privacy Owner has not approved ${VA_CONFIRMATION_PROJECTION_ID} (status ${approval.status}); no request may be sent to VA until then.`,
    );
  }
}
