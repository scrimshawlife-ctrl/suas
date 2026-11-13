/**
 * A synthetic approval of the vendored VA projection, for tests that need `sandbox` mode to
 * start. The real approval record stays DECISION_PENDING until the Privacy Owner approves.
 */

import {
  VENDORED_VA_PROJECTION,
  type VaProjectionArtifact,
} from '../../src/identity/va-projection-approval.js';

export function approvedVaProjection(
  overrides: Record<string, unknown> = {},
  projectionText: string = VENDORED_VA_PROJECTION.projectionText,
): VaProjectionArtifact {
  const approval = JSON.parse(VENDORED_VA_PROJECTION.approvalText) as Record<string, unknown>;
  return {
    projectionText,
    approvalText: JSON.stringify({
      ...approval,
      status: 'APPROVED',
      approved_by: 'synthetic-test-approver',
      approval_timestamp: '2026-11-11T00:00:00Z',
      ...overrides,
    }),
  };
}
