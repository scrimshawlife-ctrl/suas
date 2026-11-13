/**
 * Startup check on the approved VA projection (suas-specs #72 VA_CONFIRMATION_FLOW §3,
 * amendment A27; D035 §7, §14). `sandbox` starts only with the unchanged, approved
 * projection; `fixture` and `disabled` need neither. The approvals here are synthetic.
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
  VENDORED_VA_PROJECTION,
} from '../../src/identity/va-projection-approval.js';
import { validEnv } from '../helpers/env.js';
import { approvedVaProjection } from '../helpers/va-projection.js';

const vendored = (name: string) =>
  readFileSync(new URL(`../../contract/va-projection/${name}`, import.meta.url), 'utf8');
const projectionJson = JSON.parse(VENDORED_VA_PROJECTION.projectionText) as {
  allowed_field_names: string[];
  fields: Record<string, unknown>;
};
const sandbox = (SUAS_ENV: string) =>
  loadConfig(
    validEnv({
      SUAS_ENV,
      SUAS_VA_CONFIRMATION_MODE: 'sandbox',
      SUAS_VA_CONFIRMATION_BASE_URL: VA_CONFIRMATION_SANDBOX_BASE_URL,
      SUAS_VA_CONFIRMATION_API_KEY: 'synthetic-sandbox-key-1111',
    }),
  );

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

  it('refuses sandbox startup while the vendored approval is pending', () => {
    const approval = JSON.parse(VENDORED_VA_PROJECTION.approvalText) as Record<string, string>;
    expect(approval.projection_sha256).toBe(
      projectionSha256(VENDORED_VA_PROJECTION.projectionText),
    );
    expect(approval.status).not.toBe('APPROVED');
    for (const env of ['STAGING', 'LOCAL']) {
      expect(() => createVeteranConfirmationPort(sandbox(env))).toThrow(
        /has not approved VA_CONFIRMATION_V1_REQUIRED_ONLY \(status DECISION_PENDING\)/,
      );
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
    const pending = { projection: VENDORED_VA_PROJECTION };
    const fixture = loadConfig(validEnv({ SUAS_VA_CONFIRMATION_MODE: 'fixture' }));
    expect(createVeteranConfirmationPort(fixture, pending)?.providerEnvironment).toBe('NONE');
    expect(createVeteranConfirmationPort(loadConfig(validEnv({})), pending)).toBeUndefined();
  });
});
