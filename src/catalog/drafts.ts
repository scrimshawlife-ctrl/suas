/**
 * Resource Drafts: storage, review, and the publish that makes a Resource.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1 "Catalog builder": drafts keep their source link; only a
 *   SUAS Administrator's publish makes a Resource, and that publish is the
 *   verification act.
 * - SUAS-specs RESOURCES.md §5 (verification is an explicit audited action), §7
 *   (activation needs verification evidence), §9 (audit events, no Resource event).
 *
 * A draft is not a Resource: nothing here touches `resources` except `publish`,
 * which goes through the existing createResource / verifyResource / setResourceActive
 * path in one transaction. The model never sets `last_verified_at`.
 */

import type { Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import {
  contactsFromRow,
  createResource,
  resolveContacts,
  setResourceActive,
  verifyResource,
  type Resource,
  type ResourceContact,
} from '../fulfillment/index.js';
import type { ServiceCategory } from '../coordination/index.js';
import { draftFieldsSchema, type DraftChanges, type DraftFields } from './fields.js';

export const RESOURCE_DRAFT_STATUSES = ['DRAFT', 'PUBLISHED', 'REJECTED'] as const;
export type ResourceDraftStatus = (typeof RESOURCE_DRAFT_STATUSES)[number];

export interface ResourceDraft {
  readonly resourceDraftId: string;
  readonly tenantId: string;
  readonly status: ResourceDraftStatus;
  readonly sourceLink: string;
  readonly serviceName: string;
  readonly category: ServiceCategory;
  readonly counties: readonly string[];
  readonly eligibility: string | undefined;
  readonly hours: string | undefined;
  readonly contactMethod: string | undefined;
  readonly contactMethodKind: string | undefined;
  readonly contacts: readonly ResourceContact[];
  readonly area: string | undefined;
  readonly referralMethod: string | undefined;
  readonly cost: string | undefined;
  readonly publishedResourceId: string | undefined;
  readonly reviewedBy: string | undefined;
  readonly reviewedAt: Date | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface DraftRow {
  resource_draft_id: string;
  tenant_id: string;
  status: ResourceDraftStatus;
  source_url: string;
  service_name: string;
  category: ServiceCategory;
  counties: string[];
  eligibility: string | null;
  hours: string | null;
  contact_method: string | null;
  contact_method_kind: string | null;
  contacts: ResourceContact[] | null;
  area: string | null;
  referral_method: string | null;
  cost: string | null;
  published_resource_id: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `
  resource_draft_id, tenant_id, status, source_url, service_name, category, counties,
  eligibility, hours, contact_method, contact_method_kind, contacts, area, referral_method,
  cost, published_resource_id, reviewed_by, reviewed_at, created_at, updated_at
`;

function toDraft(row: DraftRow): ResourceDraft {
  return {
    resourceDraftId: row.resource_draft_id,
    tenantId: row.tenant_id,
    status: row.status,
    sourceLink: row.source_url,
    serviceName: row.service_name,
    category: row.category,
    counties: row.counties,
    eligibility: row.eligibility ?? undefined,
    hours: row.hours ?? undefined,
    contactMethod: row.contact_method ?? undefined,
    contactMethodKind: row.contact_method_kind ?? undefined,
    contacts: contactsFromRow(row.contacts, row.contact_method, row.contact_method_kind),
    area: row.area ?? undefined,
    referralMethod: row.referral_method ?? undefined,
    cost: row.cost ?? undefined,
    publishedResourceId: row.published_resource_id ?? undefined,
    reviewedBy: row.reviewed_by ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ResourceDraftNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Resource Draft not found.');
    this.name = 'ResourceDraftNotFoundError';
  }
}

/** Edit, discard or publish of a draft that an administrator already settled. */
export class ResourceDraftNotPendingError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor(status: ResourceDraftStatus) {
    super(`This Resource Draft is already ${status.toLowerCase()} and can no longer change.`);
    this.name = 'ResourceDraftNotPendingError';
  }
}

function toDraftFields(draft: ResourceDraft): DraftFields {
  return {
    service_name: draft.serviceName,
    category: draft.category,
    counties: [...draft.counties] as DraftFields['counties'],
    eligibility: draft.eligibility ?? null,
    hours: draft.hours ?? null,
    contact_method: draft.contactMethod ?? null,
    contact_method_kind: (draft.contactMethodKind ?? null) as DraftFields['contact_method_kind'],
    contacts: draft.contacts.map((contact) => ({ ...contact })),
    area: draft.area ?? null,
    referral_method: draft.referralMethod ?? null,
    cost: draft.cost ?? null,
  };
}

/** The contact list to store, with the single-contact mirror of its first entry. */
function contactsOf(fields: DraftFields) {
  return resolveContacts({
    contacts: fields.contacts ?? undefined,
    contactMethod: fields.contact_method ?? undefined,
    contactMethodKind: fields.contact_method_kind ?? undefined,
  });
}

/**
 * Merge an admin edit into the current draft. `contacts` replaces the list. A change to
 * `contact_method` or `contact_method_kind` alone replaces the first contact and keeps
 * the rest, so an older client cannot drop contacts two and three.
 */
function mergeChanges(current: ResourceDraft, changes: DraftChanges): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...toDraftFields(current), ...changes };
  const touchesSingle = 'contact_method' in changes || 'contact_method_kind' in changes;
  if (changes.contacts !== undefined) {
    if (!touchesSingle) {
      merged.contact_method = null;
      merged.contact_method_kind = null;
    }
    merged.contacts = changes.contacts ?? [];
  } else if (touchesSingle) {
    const method = merged.contact_method;
    const first =
      typeof method === 'string'
        ? [{ kind: merged.contact_method_kind ?? 'FREEFORM', value: method }]
        : [];
    merged.contacts = [...first, ...current.contacts.slice(1)];
  }
  return merged;
}

async function auditDraft(
  tx: Queryable,
  action: string,
  draft: { resourceDraftId: string; tenantId: string },
  actorId: string,
  payload: Record<string, string | null>,
): Promise<void> {
  await appendAuditEvent(tx, {
    eventType: `RESOURCE_DRAFT_${action}`,
    action: `${action}_RESOURCE_DRAFT`,
    targetType: 'ResourceDraft',
    targetId: draft.resourceDraftId,
    aggregateType: 'ResourceDraft',
    aggregateId: draft.resourceDraftId,
    tenantId: draft.tenantId,
    actorType: 'SUAS_ADMIN',
    actorId,
    payload,
  });
}

export interface CreateResourceDraftsInput {
  readonly tenantId: string;
  readonly actorId: string;
  readonly sourceLink: string;
  readonly resources: readonly DraftFields[];
}

/** Store extracted fields as DRAFT rows, each with the source link. */
export async function createResourceDrafts(
  tx: Queryable,
  input: CreateResourceDraftsInput,
): Promise<ResourceDraft[]> {
  const drafts: ResourceDraft[] = [];
  for (const fields of input.resources) {
    const contacts = contactsOf(fields);
    const result = await tx.query<DraftRow>(
      `INSERT INTO resource_drafts
         (resource_draft_id, tenant_id, source_url, service_name, category, counties,
          eligibility, hours, contact_method, contact_method_kind, contacts, area,
          referral_method, cost)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
       RETURNING ${COLUMNS}`,
      [
        input.tenantId,
        input.sourceLink,
        fields.service_name,
        fields.category,
        fields.counties,
        fields.eligibility ?? null,
        fields.hours ?? null,
        contacts.contactMethod,
        contacts.contactMethodKind,
        JSON.stringify(contacts.contacts),
        fields.area ?? null,
        fields.referral_method ?? null,
        fields.cost ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Resource Draft insert returned no row.');
    const draft = toDraft(row);
    await auditDraft(tx, 'CREATED', draft, input.actorId, { source_link: input.sourceLink });
    drafts.push(draft);
  }
  return drafts;
}

export async function findResourceDraft(
  db: Queryable,
  tenantId: string,
  resourceDraftId: string,
  options: { lock?: boolean } = {},
): Promise<ResourceDraft | undefined> {
  const result = await db.query<DraftRow>(
    `SELECT ${COLUMNS} FROM resource_drafts
     WHERE tenant_id = $1 AND resource_draft_id = $2${options.lock === true ? ' FOR UPDATE' : ''}`,
    [tenantId, resourceDraftId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toDraft(row);
}

export const DRAFT_DEFAULT_PAGE_SIZE = 20;
export const DRAFT_MAX_PAGE_SIZE = 100;

export class InvalidDraftCursorError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super('The pagination cursor is not valid.');
    this.name = 'InvalidDraftCursorError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keyset cursor over (created_at DESC, resource_draft_id DESC). */
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (createdAt !== undefined && id !== undefined && rest.length === 0 && UUID.test(id)) {
      if (!Number.isNaN(Date.parse(createdAt))) return { createdAt, id };
    }
  } catch {
    // fall through to the typed error
  }
  throw new InvalidDraftCursorError();
}

export interface ListResourceDraftsPage {
  readonly drafts: readonly ResourceDraft[];
  readonly nextCursor: string | undefined;
}

/** Newest first, bounded. Postgres keeps microseconds, so the cursor uses the stored text. */
export async function listResourceDrafts(
  db: Queryable,
  tenantId: string,
  filters: { status?: ResourceDraftStatus; limit?: number; cursor?: string } = {},
): Promise<ListResourceDraftsPage> {
  const limit = Math.min(
    Math.max(filters.limit ?? DRAFT_DEFAULT_PAGE_SIZE, 1),
    DRAFT_MAX_PAGE_SIZE,
  );
  const conditions = ['tenant_id = $1'];
  const values: unknown[] = [tenantId];
  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.cursor !== undefined) {
    const { createdAt, id } = decodeCursor(filters.cursor);
    values.push(createdAt, id);
    conditions.push(
      `(created_at, resource_draft_id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
    );
  }
  values.push(limit + 1);
  const result = await db.query<DraftRow & { created_at_text: string }>(
    `SELECT ${COLUMNS}, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
              AS created_at_text
     FROM resource_drafts
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, resource_draft_id DESC
     LIMIT $${values.length}`,
    values,
  );
  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    drafts: rows.map(toDraft),
    nextCursor:
      result.rows.length > limit && last !== undefined
        ? Buffer.from(`${last.created_at_text}|${last.resource_draft_id}`, 'utf8').toString(
            'base64url',
          )
        : undefined,
  };
}

async function lockPendingDraft(
  tx: Queryable,
  tenantId: string,
  resourceDraftId: string,
): Promise<ResourceDraft> {
  const draft = await findResourceDraft(tx, tenantId, resourceDraftId, { lock: true });
  if (draft === undefined) throw new ResourceDraftNotFoundError();
  if (draft.status !== 'DRAFT') throw new ResourceDraftNotPendingError(draft.status);
  return draft;
}

export interface EditResourceDraftInput {
  readonly tenantId: string;
  readonly resourceDraftId: string;
  readonly actorId: string;
  /** Changed fields only; `null` clears an optional field. */
  readonly changes: DraftChanges;
}

/** Edit a pending draft. The merged result must still pass the same validation. */
export async function editResourceDraft(
  tx: Queryable,
  input: EditResourceDraftInput,
): Promise<ResourceDraft> {
  const current = await lockPendingDraft(tx, input.tenantId, input.resourceDraftId);
  const merged = draftFieldsSchema.parse(mergeChanges(current, input.changes));
  const contacts = contactsOf(merged);
  const result = await tx.query<DraftRow>(
    `UPDATE resource_drafts
        SET service_name = $3, category = $4, counties = $5, eligibility = $6, hours = $7,
            contact_method = $8, contact_method_kind = $9, contacts = $10::jsonb, area = $11,
            referral_method = $12, cost = $13, updated_at = now()
      WHERE tenant_id = $1 AND resource_draft_id = $2
      RETURNING ${COLUMNS}`,
    [
      input.tenantId,
      input.resourceDraftId,
      merged.service_name,
      merged.category,
      merged.counties,
      merged.eligibility ?? null,
      merged.hours ?? null,
      contacts.contactMethod,
      contacts.contactMethodKind,
      JSON.stringify(contacts.contacts),
      merged.area ?? null,
      merged.referral_method ?? null,
      merged.cost ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ResourceDraftNotFoundError();
  const draft = toDraft(row);
  await auditDraft(tx, 'EDITED', draft, input.actorId, {
    changed_fields: Object.keys(input.changes).sort().join(','),
  });
  return draft;
}

export interface SettleResourceDraftInput {
  readonly tenantId: string;
  readonly resourceDraftId: string;
  readonly actorId: string;
}

/** Discard a pending draft. It stays on record as REJECTED; no Resource is made. */
export async function discardResourceDraft(
  tx: Queryable,
  input: SettleResourceDraftInput,
): Promise<ResourceDraft> {
  await lockPendingDraft(tx, input.tenantId, input.resourceDraftId);
  const result = await tx.query<DraftRow>(
    `UPDATE resource_drafts
        SET status = 'REJECTED', reviewed_by = $3, reviewed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND resource_draft_id = $2
      RETURNING ${COLUMNS}`,
    [input.tenantId, input.resourceDraftId, input.actorId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ResourceDraftNotFoundError();
  const draft = toDraft(row);
  await auditDraft(tx, 'DISCARDED', draft, input.actorId, {});
  return draft;
}

/**
 * Publish a pending draft: create the Resource, record the verification against the
 * draft's source link, activate it, and mark the draft PUBLISHED. One transaction,
 * so a failure at any step leaves no half-published Resource.
 */
export async function publishResourceDraft(
  tx: Queryable,
  input: SettleResourceDraftInput,
): Promise<{ draft: ResourceDraft; resource: Resource }> {
  const draft = await lockPendingDraft(tx, input.tenantId, input.resourceDraftId);

  const created = await createResource(tx, {
    tenantId: input.tenantId,
    serviceName: draft.serviceName,
    category: draft.category,
    counties: draft.counties,
    ...(draft.contactMethod !== undefined ? { contactMethod: draft.contactMethod } : {}),
    ...(draft.contactMethodKind !== undefined
      ? { contactMethodKind: draft.contactMethodKind }
      : {}),
    contacts: draft.contacts,
    ...(draft.area !== undefined ? { area: draft.area } : {}),
    ...(draft.referralMethod !== undefined ? { referralMethod: draft.referralMethod } : {}),
    ...(draft.hours !== undefined ? { hours: draft.hours } : {}),
    ...(draft.cost !== undefined ? { cost: draft.cost } : {}),
    ...(draft.eligibility !== undefined ? { eligibility: draft.eligibility } : {}),
  });
  await verifyResource(tx, {
    tenantId: input.tenantId,
    resourceId: created.resourceId,
    verificationSource: draft.sourceLink,
    actorId: input.actorId,
    idempotencyKey: `resource-draft-publish:${draft.resourceDraftId}`,
  });
  const resource = await setResourceActive(tx, {
    tenantId: input.tenantId,
    resourceId: created.resourceId,
    active: true,
    actorId: input.actorId,
  });

  const result = await tx.query<DraftRow>(
    `UPDATE resource_drafts
        SET status = 'PUBLISHED', published_resource_id = $3, reviewed_by = $4,
            reviewed_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND resource_draft_id = $2
      RETURNING ${COLUMNS}`,
    [input.tenantId, input.resourceDraftId, resource.resourceId, input.actorId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ResourceDraftNotFoundError();
  const published = toDraft(row);
  await auditDraft(tx, 'PUBLISHED', published, input.actorId, {
    resource_id: resource.resourceId,
    source_link: published.sourceLink,
  });
  return { draft: published, resource };
}
