/**
 * Authorization policy evidence.
 *
 * SUAS-specs AUTH.md §1 (authentication is not authorization), §6 (no one
 * self-elevates to SUAS-admin); SECURITY.md §2, §5 (deny by default, cross-tenant
 * leakage); API.md §4 (no existence leakage). V1_PROJECT_PLAN.md §2.1: no
 * Organizations or Responders, so the only global role is SUAS System Administrator.
 */

import { describe, expect, it } from 'vitest';
import { MfaRequiredError } from '../../src/auth/index.js';
import {
  assertMfaElevated,
  assertSuasAdmin,
  assertTenant,
  authorize,
  ForbiddenError,
  ResourceNotVisibleError,
  type AuthContext,
} from '../../src/authz/index.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

function context(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    session: {
      sessionId: 'session-1',
      tenantId: TENANT_A,
      userId: 'user-1',
      mfaElevatedAt: undefined,
      issuedAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: undefined,
    },
    tenantId: TENANT_A,
    userId: 'user-1',
    isSuasAdmin: false,
    mfaElevated: false,
    ...overrides,
  };
}

describe('SECURITY.md §2 — tenant isolation', () => {
  it('allows access within the actor tenant', () => {
    expect(() => assertTenant(context(), TENANT_A)).not.toThrow();
  });

  it('denies cross-tenant access as a not-found, so existence does not leak', () => {
    expect(() => assertTenant(context(), TENANT_B)).toThrow(ResourceNotVisibleError);
    try {
      assertTenant(context(), TENANT_B);
    } catch (error) {
      expect(error).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
      expect((error as Error).message).not.toContain(TENANT_B);
    }
  });
});

describe('AUTH.md §6 — the SUAS System Administrator grant', () => {
  it('denies the global role to a person without the grant', () => {
    expect(() => assertSuasAdmin(context())).toThrow(ForbiddenError);
  });

  it('grants the global role to a holder of the grant', () => {
    expect(() => assertSuasAdmin(context({ isSuasAdmin: true }))).not.toThrow();
  });
});

describe('AUTH.md §4 — MFA elevation boundary', () => {
  it('denies a privileged action on an unelevated session', () => {
    expect(() => assertMfaElevated(context({ isSuasAdmin: true }), 'Publishing')).toThrow(
      MfaRequiredError,
    );
  });

  it('allows it once elevated', () => {
    expect(() =>
      assertMfaElevated(context({ isSuasAdmin: true, mfaElevated: true }), 'Publishing'),
    ).not.toThrow();
  });
});

describe('SECURITY.md §5 — deny by default', () => {
  it('refuses a requirement that names no authority at all', () => {
    expect(() => authorize(context({ isSuasAdmin: true }), {})).toThrow(ForbiddenError);
  });

  it('checks tenant, admin grant, and elevation together', () => {
    const ctx = context({ isSuasAdmin: true, mfaElevated: true });
    expect(() =>
      authorize(ctx, {
        tenantId: TENANT_A,
        requireSuasAdmin: true,
        requireMfaElevation: true,
        action: 'Publishing a Resource',
      }),
    ).not.toThrow();
  });

  it('fails the tenant check before the role check, so a foreign row stays hidden', () => {
    const ctx = context({ isSuasAdmin: true });
    expect(() => authorize(ctx, { tenantId: TENANT_B, requireSuasAdmin: true })).toThrow(
      ResourceNotVisibleError,
    );
  });
});
