/**
 * Users.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import { normalizeDestination } from '../auth/secrets.js';

export const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface User {
  readonly userId: string;
  readonly tenantId: string;
  readonly status: UserStatus;
  readonly email: string | undefined;
  readonly phone: string | undefined;
  readonly deletedAt: Date | undefined;
}

interface UserRow {
  user_id: string;
  tenant_id: string;
  status: UserStatus;
  email: string | null;
  phone: string | null;
  deleted_at: Date | null;
}

const USER_COLUMNS = 'user_id, tenant_id, status, email, phone, deleted_at';

function toUser(row: UserRow): User {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    status: row.status,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    deletedAt: row.deleted_at ?? undefined,
  };
}

export interface CreateUserInput {
  readonly tenantId: string;
  readonly email?: string;
  readonly phone?: string;
  readonly status?: UserStatus;
}

export class NoEnrolledChannelError extends Error {
  readonly code = 'NO_ENROLLED_CHANNEL';
  readonly httpStatus = 422;

  constructor() {
    super(
      'A user must have at least one enrolled contact channel (email or phone) ' +
        '(SUAS-specs AUTH.md §2).',
    );
    this.name = 'NoEnrolledChannelError';
  }
}

export class UserTerminalError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'A REVOKED user is terminal and cannot change status; revoked users cannot authenticate ' +
        'or act (SUAS-specs DOMAIN_MODEL.md §2; AUTH.md §6).',
    );
    this.name = 'UserTerminalError';
  }
}

export async function createUser(db: Queryable, input: CreateUserInput): Promise<User> {
  const email = input.email === undefined ? null : normalizeDestination(input.email);
  const phone = input.phone === undefined ? null : normalizeDestination(input.phone);
  if (email === null && phone === null) {
    throw new NoEnrolledChannelError();
  }

  const result = await db.query<UserRow>(
    `INSERT INTO users (user_id, tenant_id, status, email, phone)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${USER_COLUMNS}`,
    [randomUUID(), input.tenantId, input.status ?? 'INVITED', email, phone],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('User insert returned no row.');
  return toUser(row);
}

export async function findUserById(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<User | undefined> {
  const result = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users
     WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [tenantId, userId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toUser(row);
}

export async function findUserByDestination(
  db: Queryable,
  tenantId: string,
  destination: string,
): Promise<User | undefined> {
  const normalized = normalizeDestination(destination);
  const result = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users
     WHERE tenant_id = $1 AND deleted_at IS NULL
       AND (lower(email) = lower($2) OR phone = $2)`,
    [tenantId, normalized],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toUser(row);
}

/** Destinations may exist in more than one tenant. Sign-in picks with selectUserForSignIn. */
export async function findUsersByDestination(db: Queryable, destination: string): Promise<User[]> {
  const normalized = normalizeDestination(destination);
  const result = await db.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users
     WHERE deleted_at IS NULL
       AND (lower(email) = lower($1) OR phone = $1)`,
    [normalized],
  );
  return result.rows.map(toUser);
}

export async function setUserStatus(
  db: Queryable,
  tenantId: string,
  userId: string,
  status: UserStatus,
): Promise<User | undefined> {
  const result = await db.query<UserRow>(
    `UPDATE users SET status = $3, updated_at = now()
     WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL
       AND status <> 'REVOKED'
     RETURNING ${USER_COLUMNS}`,
    [tenantId, userId, status],
  );
  const row = result.rows[0];
  if (row === undefined) {
    const existing = await findUserById(db, tenantId, userId);
    if (existing?.status === 'REVOKED') throw new UserTerminalError();
    return undefined;
  }
  return toUser(row);
}

export async function softDeleteUser(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE users SET deleted_at = now(), status = 'REVOKED', updated_at = now()
     WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [tenantId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}
