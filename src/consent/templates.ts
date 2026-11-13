/**
 * Consent template versions.
 *
 * Spec citations:
 * - SUAS-specs CONSENT.md §6 — grants reference `consent_template_version`;
 *   template text is published by SUAS-admin; exact copy is `NOT_COMPUTABLE`
 *   until written; "Do not ship grants against unpublished templates."
 * - SUAS-specs ADMIN.md §2 — consent templates are a SUAS-admin publication
 *   surface, with MFA and audit.
 *
 * This module ships no template copy. Bodies are supplied by an administrator at
 * runtime, because no released text exists to ship.
 */

import type { Queryable } from '../db/transaction.js';

export type ConsentTemplateStatus = 'DRAFT' | 'PUBLISHED' | 'SUPERSEDED';

/**
 * Template key of the RED-alert grant a Veteran gives a Trusted Contact (SAFETY.md §3.3).
 * The web looks up its current version with `GET /consent-templates/published?purpose=`.
 */
export const RED_ALERT_CONSENT_TEMPLATE_KEY = 'red-alert-trusted-contact';

/** Template keys are short lowercase slugs; the version key is `<key>@<version>`. */
export const CONSENT_TEMPLATE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONSENT_TEMPLATE_VERSION_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*@[1-9][0-9]{0,8}$/;

export interface ConsentTemplateVersion {
  readonly versionKey: string;
  readonly templateKey: string;
  readonly version: number;
  readonly status: ConsentTemplateStatus;
  readonly body: string | undefined;
  readonly publishedAt: Date | undefined;
  readonly createdAt: Date;
}

/** A new version lost a race with another create of the same template key. API.md §6. */
export class ConsentTemplateVersionConflictError extends Error {
  readonly code = 'STALE_STATE';
  readonly httpStatus = 409;

  constructor() {
    super('Another version of this consent template was created at the same time. Try again.');
    this.name = 'ConsentTemplateVersionConflictError';
  }
}

/** Publish of a version that is not a DRAFT: published and superseded versions are final. */
export class ConsentTemplateNotDraftError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor(status: ConsentTemplateStatus) {
    super(`This consent template version is already ${status.toLowerCase()} and cannot change.`);
    this.name = 'ConsentTemplateNotDraftError';
  }
}

export class ConsentTemplateNotPublishedError extends Error {
  readonly code = 'CONSENT_TEMPLATE_UNAVAILABLE';
  readonly httpStatus = 422;

  constructor(versionKey: string) {
    super(
      `Consent template version "${versionKey}" is not published. A grant cannot reference an ` +
        `unpublished template (SUAS-specs CONSENT.md §6).`,
    );
    this.name = 'ConsentTemplateNotPublishedError';
  }
}

interface TemplateRow {
  version_key: string;
  template_key: string;
  version: number;
  status: ConsentTemplateStatus;
  body: string | null;
  published_at: Date | null;
  created_at: Date;
}

const TEMPLATE_COLUMNS =
  'version_key, template_key, version, status, body, published_at, created_at';

function toTemplate(row: TemplateRow): ConsentTemplateVersion {
  return {
    versionKey: row.version_key,
    templateKey: row.template_key,
    version: row.version,
    status: row.status,
    body: row.body ?? undefined,
    publishedAt: row.published_at ?? undefined,
    createdAt: row.created_at,
  };
}

/** Compose the textual version key. DATA_MODEL.md §1 allows a textual version key. */
export function consentTemplateVersionKey(templateKey: string, version: number): string {
  return `${templateKey}@${version}`;
}

export async function createConsentTemplateVersion(
  db: Queryable,
  input: { templateKey: string; version: number; body?: string },
): Promise<ConsentTemplateVersion> {
  const versionKey = consentTemplateVersionKey(input.templateKey, input.version);
  const result = await db.query<TemplateRow>(
    `INSERT INTO consent_template_versions (version_key, template_key, version, body)
     VALUES ($1, $2, $3, $4)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [versionKey, input.templateKey, input.version, input.body ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Consent template insert returned no row.');
  return toTemplate(row);
}

/**
 * Create the next version of a template key (1 for a new key) as a DRAFT. The version
 * number is assigned here, so two admins never pick the same one; a concurrent create
 * of the same key loses on the unique key and is told to retry.
 */
export async function createNextConsentTemplateVersion(
  db: Queryable,
  input: { templateKey: string; body: string },
): Promise<ConsentTemplateVersion> {
  try {
    const result = await db.query<TemplateRow>(
      `INSERT INTO consent_template_versions (version_key, template_key, version, body)
       SELECT $1 || '@' || next.version, $1, next.version, $2
         FROM (SELECT COALESCE(MAX(version), 0) + 1 AS version
                 FROM consent_template_versions WHERE template_key = $1) next
       RETURNING ${TEMPLATE_COLUMNS}`,
      [input.templateKey, input.body],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Consent template insert returned no row.');
    return toTemplate(row);
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === '23505') {
      throw new ConsentTemplateVersionConflictError();
    }
    throw error;
  }
}

export interface PublishedConsentTemplate {
  readonly template: ConsentTemplateVersion;
  /** Versions of the same template key that this publish moved to SUPERSEDED. */
  readonly supersededVersionKeys: readonly string[];
}

/**
 * Publish a DRAFT version and supersede the key's earlier PUBLISHED version, so each
 * template key has one current version (CONSENT.md §6). Existing grants keep the version
 * they cite; new grants need the current one. Returns undefined when the version is not
 * a DRAFT. Callers append the Audit Event, since the acting administrator's identity and
 * request context belong to them (ADMIN.md §2). Run it in a transaction: the row lock
 * keeps two publishes of the same key from both staying PUBLISHED.
 */
export async function publishConsentTemplateVersion(
  db: Queryable,
  versionKey: string,
  publishedBy: string | undefined,
): Promise<PublishedConsentTemplate | undefined> {
  await db.query(
    `SELECT 1 FROM consent_template_versions
      WHERE template_key = (SELECT template_key FROM consent_template_versions
                             WHERE version_key = $1)
      FOR UPDATE`,
    [versionKey],
  );
  const result = await db.query<TemplateRow>(
    `UPDATE consent_template_versions
       SET status = 'PUBLISHED', published_at = now(), published_by = $2
     WHERE version_key = $1 AND status = 'DRAFT'
     RETURNING ${TEMPLATE_COLUMNS}`,
    [versionKey, publishedBy ?? null],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const superseded = await db.query<{ version_key: string }>(
    `UPDATE consent_template_versions SET status = 'SUPERSEDED'
      WHERE template_key = $1 AND status = 'PUBLISHED' AND version_key <> $2
      RETURNING version_key`,
    [row.template_key, row.version_key],
  );
  return {
    template: toTemplate(row),
    supersededVersionKeys: superseded.rows.map((entry) => entry.version_key).sort(),
  };
}

/** Every version, grouped by template key, newest version first. */
export async function listConsentTemplateVersions(
  db: Queryable,
): Promise<ConsentTemplateVersion[]> {
  const result = await db.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM consent_template_versions
      ORDER BY template_key, version DESC`,
  );
  return result.rows.map(toTemplate);
}

/** The current PUBLISHED version of a template key, the one new grants cite. */
export async function findPublishedConsentTemplate(
  db: Queryable,
  templateKey: string,
): Promise<ConsentTemplateVersion | undefined> {
  const result = await db.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM consent_template_versions
      WHERE template_key = $1 AND status = 'PUBLISHED'
      ORDER BY version DESC LIMIT 1`,
    [templateKey],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toTemplate(row);
}

export async function findConsentTemplateVersion(
  db: Queryable,
  versionKey: string,
): Promise<ConsentTemplateVersion | undefined> {
  const result = await db.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM consent_template_versions WHERE version_key = $1`,
    [versionKey],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toTemplate(row);
}

/** Throw unless the version exists and is published. CONSENT.md §6. */
export async function assertTemplatePublished(db: Queryable, versionKey: string): Promise<void> {
  const template = await findConsentTemplateVersion(db, versionKey);
  if (template === undefined || template.status !== 'PUBLISHED') {
    throw new ConsentTemplateNotPublishedError(versionKey);
  }
}
