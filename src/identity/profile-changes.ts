/**
 * A person changes their own county or display name, with an Audit Event when the value
 * really changed (R9.5 a, contributor proposal, specs #72; EVENT_MODEL.md §4). The payload
 * is empty: neither the old nor the new value goes into the audit store.
 */

import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/index.js';
import { appendAuditEvent } from '../events/index.js';
import type { ServiceCounty } from './counties.js';
import { setUserCounty, setUserDisplayName, type User } from './users.js';

interface ProfileChangeInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly correlationId?: string;
}

const AUDIT = {
  county: { eventType: 'USER_COUNTY_CHANGED', action: 'CHANGE_USER_COUNTY' },
  display_name: { eventType: 'USER_DISPLAY_NAME_CHANGED', action: 'CHANGE_USER_DISPLAY_NAME' },
} as const;

async function changeProfileField(
  pool: Pool,
  field: keyof typeof AUDIT,
  input: ProfileChangeInput,
  write: (tx: Queryable) => Promise<User | undefined>,
): Promise<User | undefined> {
  return withTransaction(pool, async (tx) => {
    // Locks the row so the before/after comparison sees no concurrent write.
    const before = await tx.query<{ value: string | null }>(
      `SELECT ${field} AS value FROM users
        WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [input.tenantId, input.userId],
    );
    const user = await write(tx);
    if (user === undefined) return undefined;
    const after = field === 'county' ? user.county : user.displayName;
    if ((before.rows[0]?.value ?? undefined) !== after) {
      await appendAuditEvent(tx, {
        ...AUDIT[field],
        targetType: 'User',
        targetId: user.userId,
        aggregateType: 'User',
        aggregateId: user.userId,
        tenantId: user.tenantId,
        actorType: 'USER',
        actorId: user.userId,
        payload: {},
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      });
    }
    return user;
  });
}

export function changeUserCounty(
  pool: Pool,
  input: ProfileChangeInput & { readonly county: ServiceCounty },
): Promise<User | undefined> {
  return changeProfileField(pool, 'county', input, (tx) =>
    setUserCounty(tx, input.tenantId, input.userId, input.county),
  );
}

export function changeUserDisplayName(
  pool: Pool,
  input: ProfileChangeInput & { readonly displayName: string },
): Promise<User | undefined> {
  return changeProfileField(pool, 'display_name', input, (tx) =>
    setUserDisplayName(tx, input.tenantId, input.userId, input.displayName),
  );
}
