/**
 * Service Request Draft storage (table `service_request_drafts`, migration 0013).
 *
 * V1_PROJECT_PLAN.md §2.1: the Intake Assistant produces a draft; the Veteran
 * reviews, edits and submits it. `intake_text` is what the Veteran typed. It is a
 * plain column protected by database encryption at rest only, so it is read and
 * written here and nowhere else, and must never be logged or copied into a Service
 * Request, an event payload or an error message.
 *
 * `meeting_place` (in `details`) is sensitive free text too, but it is meant to move:
 * submit copies it, with the summary and timing, into the Service Request's `details`
 * in the same database, where the requester and the accepter read it. It must still
 * never be logged, listed, or put in an event or audit payload.
 */

import { ResourceNotVisibleError } from '../authz/index.js';
import type { Queryable } from '../db/index.js';
import type { IntakeDraftFields } from './assistant.js';
import type { IntakeCategory } from './tools.js';

export type DraftStatus = 'DRAFT' | 'SUBMITTED' | 'DISCARDED';

export interface ServiceRequestDraft {
  readonly draftId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly status: DraftStatus;
  readonly fields: IntakeDraftFields;
  readonly intakeText: string;
  readonly serviceRequestId: string | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly submittedAt: Date | undefined;
}

interface DraftRow {
  draft_id: string;
  tenant_id: string;
  user_id: string;
  status: DraftStatus;
  category: IntakeCategory | null;
  details: { summary?: unknown; timing?: unknown; meeting_place?: unknown };
  intake_text: string;
  service_request_id: string | null;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
}

const DRAFT_COLUMNS = `draft_id, tenant_id, user_id, status, category, details, intake_text,
  service_request_id, created_at, updated_at, submitted_at`;

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function toDraft(row: DraftRow): ServiceRequestDraft {
  return {
    draftId: row.draft_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    status: row.status,
    fields: {
      category: row.category,
      summary: text(row.details.summary),
      timing: text(row.details.timing),
      meetingPlace: text(row.details.meeting_place),
    },
    intakeText: row.intake_text,
    serviceRequestId: row.service_request_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at ?? undefined,
  };
}

/** The jsonb stored in `details`: only the fields that are set. */
export function draftDetails(fields: IntakeDraftFields): Record<string, string> {
  return {
    ...(fields.summary !== null ? { summary: fields.summary } : {}),
    ...(fields.timing !== null ? { timing: fields.timing } : {}),
    ...(fields.meetingPlace !== null ? { meeting_place: fields.meetingPlace } : {}),
  };
}

export class DraftNotEditableError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor() {
    super('This draft was already submitted or discarded and can no longer be changed.');
    this.name = 'DraftNotEditableError';
  }
}

/** Everything the Veteran typed into one draft. Keeps a prompt and a stored row small. */
export const INTAKE_TEXT_TOTAL_MAX = 6_000;

export class DraftTooLongError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super('This draft has reached its length limit. Edit the draft or start a new one.');
    this.name = 'DraftTooLongError';
  }
}

export class DraftIncompleteError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super('Choose a category and describe the need before submitting the draft.');
    this.name = 'DraftIncompleteError';
  }
}

export async function createDraft(
  db: Queryable,
  input: {
    readonly draftId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly intakeText: string;
    readonly fields: IntakeDraftFields;
  },
): Promise<ServiceRequestDraft> {
  const result = await db.query<DraftRow>(
    `INSERT INTO service_request_drafts
       (draft_id, tenant_id, user_id, category, details, intake_text)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${DRAFT_COLUMNS}`,
    [
      input.draftId,
      input.tenantId,
      input.userId,
      input.fields.category,
      JSON.stringify(draftDetails(input.fields)),
      input.intakeText,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Draft insert returned no row.');
  return toDraft(row);
}

/**
 * A draft owned by this Veteran. Someone else's draft, another tenant's, and a
 * missing one are all the same 404 (API.md §4).
 */
export async function findOwnedDraft(
  db: Queryable,
  tenantId: string,
  userId: string,
  draftId: string,
  options: { readonly lock?: boolean } = {},
): Promise<ServiceRequestDraft> {
  const result = await db.query<DraftRow>(
    `SELECT ${DRAFT_COLUMNS} FROM service_request_drafts
     WHERE tenant_id = $1 AND user_id = $2 AND draft_id = $3
     ${options.lock === true ? 'FOR UPDATE' : ''}`,
    [tenantId, userId, draftId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ResourceNotVisibleError();
  return toDraft(row);
}

/**
 * Replace the editable content of a draft that is still `DRAFT`. Used for an
 * assistant turn (new text and fields) and for the Veteran's own edit (fields
 * only). A draft that was submitted or discarded meanwhile is a conflict.
 */
export async function saveDraftContent(
  db: Queryable,
  draft: ServiceRequestDraft,
  content: { readonly fields: IntakeDraftFields; readonly intakeText?: string },
): Promise<ServiceRequestDraft> {
  const result = await db.query<DraftRow>(
    `UPDATE service_request_drafts
        SET category = $4, details = $5, intake_text = COALESCE($6, intake_text), updated_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND draft_id = $3 AND status = 'DRAFT'
      RETURNING ${DRAFT_COLUMNS}`,
    [
      draft.tenantId,
      draft.userId,
      draft.draftId,
      content.fields.category,
      JSON.stringify(draftDetails(content.fields)),
      content.intakeText ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new DraftNotEditableError();
  return toDraft(row);
}

/** Link a draft to the Service Request created from it. Caller holds the row lock. */
export async function markDraftSubmitted(
  db: Queryable,
  draft: ServiceRequestDraft,
  serviceRequestId: string,
): Promise<ServiceRequestDraft> {
  const result = await db.query<DraftRow>(
    `UPDATE service_request_drafts
        SET status = 'SUBMITTED', service_request_id = $4, submitted_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND user_id = $2 AND draft_id = $3 AND status = 'DRAFT'
      RETURNING ${DRAFT_COLUMNS}`,
    [draft.tenantId, draft.userId, draft.draftId, serviceRequestId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new DraftNotEditableError();
  return toDraft(row);
}
