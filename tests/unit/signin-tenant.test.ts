import { describe, expect, it } from 'vitest';
import { selectUserForSignIn } from '../../src/identity/signin-tenant.js';
import type { User } from '../../src/identity/users.js';

function user(tenantId: string): User {
  return {
    userId: `user-${tenantId}`,
    tenantId,
    status: 'ACTIVE',
    email: 'v@example.invalid',
    phone: undefined,
    deletedAt: undefined,
  };
}

describe('selectUserForSignIn', () => {
  it('uses the only enrolled match when no tenant is sent', () => {
    const only = user('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(selectUserForSignIn([only], undefined)).toBe(only);
  });

  it('does not guess when the email exists in two tenants', () => {
    expect(
      selectUserForSignIn(
        [
          user('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
          user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
        ],
        undefined,
      ),
    ).toBeUndefined();
  });

  it('filters by an asserted tenant when a client still sends one', () => {
    const keep = user('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const other = user('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(selectUserForSignIn([keep, other], keep.tenantId)).toBe(keep);
  });
});
