/**
 * Synthetic deletion-drill contract evidence (no database).
 *
 * SUAS-specs PRIVACY.md §2, §9, §10; SECURITY.md §2; ENVIRONMENT.md §2, §5;
 * TESTING.md §11–§12; EVENT_MODEL.md §3.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, type SuasConfig } from '../../src/config/index.js';
import { DOMAIN_EVENT_TYPES } from '../../src/events/index.js';
import {
  assertDeletionDrillEnvironment,
  DELETION_DRILL_TIMEOUT_MS,
  DELETION_REQUEST_AUDIT_EVENT_TYPE,
  DeletionDrillEnvironmentError,
  deletionDrillNote,
  isDeletionRequestDomainEvent,
  PRIVACY_GATE_VERDICT,
} from '../../src/privacy/deletion-drill.js';
import { validEnv } from '../helpers/env.js';

function testConfig(overrides: Partial<SuasConfig> = {}): SuasConfig {
  const base = loadConfig(validEnv());
  return {
    ...base,
    ...overrides,
    database: {
      ...base.database,
      ...(overrides.database ?? {}),
    },
  };
}

describe('PRIVACY.md §10 — deletion drill refuses non-synthetic targets', () => {
  it('accepts a TEST synthetic configuration', () => {
    expect(() => assertDeletionDrillEnvironment(testConfig())).not.toThrow();
  });

  it('refuses PRODUCTION', () => {
    expect(() => assertDeletionDrillEnvironment(testConfig({ environment: 'PRODUCTION' }))).toThrow(
      DeletionDrillEnvironmentError,
    );
  });

  it('refuses STAGING so the mutating drill cannot erase a shared soak', () => {
    expect(() => assertDeletionDrillEnvironment(testConfig({ environment: 'STAGING' }))).toThrow(
      /LOCAL and TEST/,
    );
  });

  it('refuses real external effects', () => {
    expect(() =>
      assertDeletionDrillEnvironment(testConfig({ allowRealExternalEffects: true })),
    ).toThrow(/real external effects/);
  });

  it('refuses a database URL that looks like production', () => {
    expect(() =>
      assertDeletionDrillEnvironment(
        testConfig({
          database: {
            url: 'postgresql://suas:suas@prod-db.example.invalid:5432/suas_production',
            poolMax: 5,
            migrationsMode: 'validate',
          },
        }),
      ),
    ).toThrow(/production marker/);
  });

  it('refuses a missing DATABASE_URL', () => {
    expect(() =>
      assertDeletionDrillEnvironment(
        testConfig({
          database: { url: undefined, poolMax: 5, migrationsMode: 'off' },
        }),
      ),
    ).toThrow(/DATABASE_URL/);
  });
});

describe('EVENT_MODEL.md §3 — the drill does not invent a Domain Event type', () => {
  it('keeps DELETION_REQUEST off the released Domain Event catalog', () => {
    expect(DOMAIN_EVENT_TYPES).not.toContain(DELETION_REQUEST_AUDIT_EVENT_TYPE);
    expect(isDeletionRequestDomainEvent()).toBe(false);
  });
});

describe('TESTING.md §11 — PRIVACY does not advance from this drill', () => {
  it('fixes the gate verdict at NOT_READY', () => {
    expect(PRIVACY_GATE_VERDICT).toBe('NOT_READY');
  });

  it('does not claim HIPAA or a released RTO', () => {
    const note = deletionDrillNote();
    expect(note).toMatch(/NOT_READY/);
    expect(note).toMatch(/No HIPAA claim/);
    expect(note).not.toMatch(/HIPAA compliant/i);
    expect(DELETION_DRILL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(deletionDrillNote()).toMatch(/D-007/);
  });

  it('keeps the module free of a READY or HIPAA-compliant assignment', () => {
    const source = readFileSync(new URL('../../src/privacy/deletion-drill.ts', import.meta.url), {
      encoding: 'utf8',
    });
    expect(source).not.toMatch(/privacy_gate:\s*'READY'/);
    expect(source).not.toMatch(/HIPAA compliant/i);
  });
});
