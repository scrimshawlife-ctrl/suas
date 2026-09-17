import type { User } from './users.js';

/**
 * Pick the User for passwordless sign-in.
 * The person does not choose an organization.
 * An asserted tenant_id is only used as a filter when a client still sends the
 * old field. Two matches with no asserted tenant do not sign in.
 */
export function selectUserForSignIn(
  users: readonly User[],
  assertedTenantId: string | undefined,
): User | undefined {
  if (assertedTenantId !== undefined) {
    return users.find((user) => user.tenantId === assertedTenantId);
  }
  if (users.length === 1) {
    return users[0];
  }
  return undefined;
}
