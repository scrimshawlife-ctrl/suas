/**
 * Startup check on the approved VA projection (suas-specs #72 VA_CONFIRMATION_FLOW §3,
 * amendment A27; D035 §7, §14). `sandbox` starts only with the unchanged, approved
 * projection; `fixture` and `disabled` need neither. The vendored record is the released
 * 0.10.0 approval; every other approval or pending record here is synthetic.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createVeteranConfirmationPort } from '../../src/identity/va-confirmation-factory.js';
import {
  VA_CONFIRMATION_PROJECTION_FIELDS,
  VA_CONFIRMATION_SANDBOX_BASE_URL,
  vaConfirmationProjectionSchema,
} from '../../src/identity/va-confirmation.js';
import {
  assertVaProjectionApproved,
  projectionSha256,
  VaProjectionNotApprovedError,
  VENDORED_VA_PROJECTION,
  type VaProjectionArtifact,
} from '../../src/identity/va-projection-approval.js';
import { validEnv } from '../helpers/env.js';
import { approvedVaProjection } from '../helpers/va-projection.js';

const vendored = (name: string) =>
  readFileSync(new URL(`../../contract/va-projection/${name}`, import.meta.url), 'utf8');
const projectionJson = JSON.parse(VENDORED_VA_PROJECTION.projectionText) as {
  allowed_field_names: string[];
  fields: Record<string, unknown>;
};
// STAGING calls VA only through the verify function (VA_CONFIRMATION_FLOW W9 item 4); the
// approval check runs before either adapter is built.
const sandbox = (SUAS_ENV: string) =>
  loadConfig(
    validEnv({
      SUAS_ENV,
      SUAS_VA_CONFIRMATION_MODE: 'sandbox',
      ...(SUAS_ENV === 'STAGING'
        ? { SUAS_VA_CONFIRMATION_RELAY_FUNCTION: 'suas-va-verify', SUAS_AWS_REGION: 'us-west-2' }
        : {
            SUAS_VA_CONFIRMATION_BASE_URL: VA_CONFIRMATION_SANDBOX_BASE_URL,
            SUAS_VA_CONFIRMATION_API_KEY: 'synthetic-sandbox-key-1111',
          }),
    }),
  );
const pendingApproval = approvedVaProjection({
  status: 'DECISION_PENDING',
  approved_by: null,
  approval_timestamp: null,
});

describe('approved VA projection (A27)', () => {
  it('embeds the vendored files exactly (run npm run va:projection after copying them)', () => {
    expect(VENDORED_VA_PROJECTION.projectionText).toBe(
      vendored('va-confirmation-v1-required-only.projection.json'),
    );
    expect(VENDORED_VA_PROJECTION.approvalText).toBe(
      vendored('va-confirmation-v1-required-only.approval.json'),
    );
  });

  it('sends exactly the fields the projection file allows', () => {
    const allowed = [...projectionJson.allowed_field_names].sort();
    expect([...VA_CONFIRMATION_PROJECTION_FIELDS].sort()).toEqual(allowed);
    expect(Object.keys(vaConfirmationProjectionSchema.shape).sort()).toEqual(allowed);
    expect(Object.keys(projectionJson.fields).sort()).toEqual(allowed);
  });

  it('starts sandbox in STAGING and LOCAL on the vendored approval (released in 0.10.0)', () => {
    const approval = JSON.parse(VENDORED_VA_PROJECTION.approvalText) as Record<string, string>;
    expect(approval.projection_sha256).toBe(
      projectionSha256(VENDORED_VA_PROJECTION.projectionText),
    );
    expect(approval.status).toBe('APPROVED');
    for (const env of ['STAGING', 'LOCAL']) {
      expect(createVeteranConfirmationPort(sandbox(env))?.providerEnvironment).toBe('SANDBOX');
    }
  });

  it('refuses sandbox startup while an approval is pending', () => {
    for (const env of ['STAGING', 'LOCAL']) {
      expect(() =>
        createVeteranConfirmationPort(sandbox(env), { projection: pendingApproval }),
      ).toThrow(/has not approved VA_CONFIRMATION_V1_REQUIRED_ONLY \(status DECISION_PENDING\)/);
    }
  });

  it('refuses a tampered projection even when approved, and an approval missing its approver', () => {
    const tampered = VENDORED_VA_PROJECTION.projectionText.replace('"zipCode"', '"ssn"');
    expect(() => assertVaProjectionApproved(approvedVaProjection({}, tampered))).toThrow(
      /does not match projection_sha256/,
    );
    expect(() =>
      createVeteranConfirmationPort(sandbox('STAGING'), {
        projection: approvedVaProjection({}, `${VENDORED_VA_PROJECTION.projectionText} `),
      }),
    ).toThrow(/does not match projection_sha256/);
    expect(() => assertVaProjectionApproved(approvedVaProjection({ approved_by: null }))).toThrow(
      /has not approved/,
    );
    expect(() =>
      assertVaProjectionApproved(approvedVaProjection({ projection_id: 'WITH_SSN' })),
    ).toThrow(/not VA_CONFIRMATION_V1_REQUIRED_ONLY/);
  });

  it('starts sandbox once the unchanged projection is approved', () => {
    const port = createVeteranConfirmationPort(sandbox('STAGING'), {
      projection: approvedVaProjection(),
    });
    expect(port?.providerEnvironment).toBe('SANDBOX');
  });

  it('needs no approval for fixture or disabled, which send nothing to VA', () => {
    const pending = { projection: pendingApproval };
    const fixture = loadConfig(validEnv({ SUAS_VA_CONFIRMATION_MODE: 'fixture' }));
    expect(createVeteranConfirmationPort(fixture, pending)?.providerEnvironment).toBe('NONE');
    expect(createVeteranConfirmationPort(loadConfig(validEnv({})), pending)).toBeUndefined();
  });
});

/** The exact refusal, so a reworded or swapped check shows up here. */
function refusal(artifact: VaProjectionArtifact): { name: string; message: string } | undefined {
  try {
    assertVaProjectionApproved(artifact);
    return undefined;
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(VaProjectionNotApprovedError);
    const { name, message } = error as Error;
    return { name, message };
  }
}
const refused = (reason: string) => ({
  name: 'VaProjectionNotApprovedError',
  message: `SUAS_VA_CONFIRMATION_MODE=sandbox refused: ${reason}`,
});
const NOT_APPROVED = (status: string) =>
  refused(
    `the Privacy Owner has not approved VA_CONFIRMATION_V1_REQUIRED_ONLY (status ${status}); no request may be sent to VA until then.`,
  );
const approvalWithout = (field: string): VaProjectionArtifact => {
  const record = JSON.parse(approvedVaProjection().approvalText) as Record<string, unknown>;
  delete record[field];
  return { ...approvedVaProjection(), approvalText: JSON.stringify(record) };
};

describe('assertVaProjectionApproved', () => {
  it('passes the released vendored approval and a synthetic approved record', () => {
    expect(refusal(VENDORED_VA_PROJECTION)).toBeUndefined();
    expect(refusal(approvedVaProjection())).toBeUndefined();
  });

  it.each([
    ['pending', { status: 'DECISION_PENDING' }, 'DECISION_PENDING'],
    ['a status in another case', { status: 'approved' }, 'approved'],
    ['no approver', { approved_by: null }, 'APPROVED'],
    ['no approval time', { approval_timestamp: null }, 'APPROVED'],
  ])('refuses an unapproved record (%s)', (_label, overrides, status) => {
    expect(refusal(approvedVaProjection(overrides))).toEqual(NOT_APPROVED(status));
  });

  it.each([
    ['an empty approval record', { ...approvedVaProjection(), approvalText: '' }],
    ['an approval record that is not JSON', { ...approvedVaProjection(), approvalText: '{' }],
  ])('refuses %s as not valid JSON', (_label, artifact) => {
    expect(refusal(artifact)).toEqual(refused('the projection approval record is not valid JSON.'));
  });

  it.each(['status', 'approved_by', 'approval_timestamp', 'projection_sha256', 'projection_id'])(
    'refuses an approval record missing %s as malformed',
    (field) => {
      expect(refusal(approvalWithout(field))).toEqual(
        refused('the projection approval record is malformed.'),
      );
    },
  );

  it('refuses a projection_sha256 that is not 64 lowercase hex characters as malformed', () => {
    const upper = projectionSha256(VENDORED_VA_PROJECTION.projectionText).toUpperCase();
    expect(refusal(approvedVaProjection({ projection_sha256: upper }))).toEqual(
      refused('the projection approval record is malformed.'),
    );
  });

  it('refuses a missing or malformed projection file', () => {
    expect(refusal(approvedVaProjection({}, ''))).toEqual(
      refused('the projection file is not valid JSON.'),
    );
    expect(refusal(approvedVaProjection({}, '{}'))).toEqual(
      refused('the projection file is malformed.'),
    );
  });

  it('refuses a mismatched projection id in the approval record or the projection file', () => {
    expect(refusal(approvedVaProjection({ projection_id: 'WITH_SSN' }))).toEqual(
      refused('the projection is WITH_SSN, not VA_CONFIRMATION_V1_REQUIRED_ONLY.'),
    );
    const renamed = VENDORED_VA_PROJECTION.projectionText.replace(
      '"VA_CONFIRMATION_V1_REQUIRED_ONLY"',
      '"WITH_SSN"',
    );
    expect(renamed).not.toBe(VENDORED_VA_PROJECTION.projectionText);
    expect(
      refusal(approvedVaProjection({ projection_sha256: projectionSha256(renamed) }, renamed)),
    ).toEqual(refused('the projection is WITH_SSN, not VA_CONFIRMATION_V1_REQUIRED_ONLY.'));
  });

  it('refuses projection bytes that do not match projection_sha256, even when approved', () => {
    const tampered = VENDORED_VA_PROJECTION.projectionText.replace('"zipCode"', '"ssn"');
    for (const projectionText of [tampered, `${VENDORED_VA_PROJECTION.projectionText}\n`]) {
      expect(refusal(approvedVaProjection({}, projectionText))).toEqual(
        refused('the projection file does not match projection_sha256 in its approval record.'),
      );
    }
  });
});
