import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  CANONICAL_SOAK_PROFILE,
  configFromEnv,
  runSoak,
  type SoakConfig,
} from '../../scripts/synthetic-staging-soak.js';

function safeEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SUAS_ENV: 'STAGING',
    SUAS_SOAK_CONFIRM: 'synthetic-staging-read-only',
    SUAS_E2E_BASE_URL: 'https://staging.suas.example',
    SUAS_E2E_VETERAN_BEARER: 'synthetic-veteran-secret',
    SUAS_E2E_RESPONDER_BEARER: 'synthetic-responder-secret',
    D007_DELETION_EXECUTION: 'disabled',
    D007_EXPORT_DELIVERY: 'disabled',
    D007_365_DAY_PURGE: 'disabled',
    D025_REPORTING: 'disabled',
    REAL_WORLD_EFFECTS: 'disabled',
    PILOT_LAUNCH: 'blocked',
    PRODUCTION_LAUNCH: 'blocked',
    SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
    SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
    ...overrides,
  };
}

function shortConfig(): SoakConfig {
  return {
    ...configFromEnv(
      safeEnv({
        SUAS_SOAK_WARMUP_SECONDS: '0.01',
        SUAS_SOAK_STEADY_SECONDS: '0.01',
        SUAS_SOAK_PEAK_SECONDS: '0.01',
        SUAS_SOAK_DRAIN_SECONDS: '0.01',
        SUAS_SOAK_REQUEST_TIMEOUT_SECONDS: '1',
      }),
    ),
    outputPath: 'unused.json',
  };
}

describe('synthetic STAGING soak configuration', () => {
  it('uses the canonical fixed profile by default', () => {
    const config = configFromEnv(safeEnv());
    expect(config.warmupDurationMs).toBe(CANONICAL_SOAK_PROFILE.warmup.durationSeconds * 1_000);
    expect(config.steadyDurationMs).toBe(CANONICAL_SOAK_PROFILE.steady.durationSeconds * 1_000);
    expect(config.peakDurationMs).toBe(CANONICAL_SOAK_PROFILE.peak.durationSeconds * 1_000);
    expect(config.drainDurationMs).toBe(CANONICAL_SOAK_PROFILE.drainSeconds * 1_000);
  });

  it('fails closed when a safety lock, confirmation, target, or credential is absent', () => {
    expect(() => configFromEnv(safeEnv({ REAL_WORLD_EFFECTS: 'enabled' }))).toThrow(
      'REAL_WORLD_EFFECTS must equal disabled',
    );
    expect(() => configFromEnv(safeEnv({ SUAS_SOAK_CONFIRM: 'no' }))).toThrow('SUAS_SOAK_CONFIRM');
    expect(() => configFromEnv(safeEnv({ SUAS_E2E_BASE_URL: '' }))).toThrow(
      'There is intentionally no default deployment host',
    );
    expect(() => configFromEnv(safeEnv({ SUAS_E2E_VETERAN_BEARER: '' }))).toThrow(
      'SUAS_E2E_VETERAN_BEARER is required',
    );
  });

  it('allows shorter test durations but rejects durations above the canonical profile', () => {
    expect(configFromEnv(safeEnv({ SUAS_SOAK_STEADY_SECONDS: '0.01' })).steadyDurationMs).toBe(10);
    expect(() => configFromEnv(safeEnv({ SUAS_SOAK_STEADY_SECONDS: '7201' }))).toThrow(
      'no more than 7200 seconds',
    );
  });
});

describe('synthetic STAGING soak runner', () => {
  it('issues only the fixed GET profile and records no credentials or response bodies', async () => {
    const calls: { method: string | undefined; url: string; authorization: string | null }[] = [];
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const headers = new Headers(init?.headers);
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      calls.push({
        method: init?.method,
        url,
        authorization: headers.get('authorization'),
      });
      return Promise.resolve(
        new Response('{"synthetic_private_field":"discard-me"}', { status: 200 }),
      );
    });

    const summary = await runSoak(shortConfig(), { fetch: fetchMock, pacingMs: 1 });
    const serialized = JSON.stringify(summary);

    expect(calls.length).toBeGreaterThanOrEqual(16);
    expect(new Set(calls.map((call) => call.method))).toEqual(new Set(['GET']));
    expect(new Set(calls.map((call) => new URL(call.url).pathname))).toEqual(
      new Set(['/api/v0/health', '/api/v0/resources', '/api/v0/veterans/me', '/api/v0/cases']),
    );
    expect(calls.some((call) => call.authorization === 'Bearer synthetic-veteran-secret')).toBe(
      true,
    );
    expect(calls.some((call) => call.authorization === 'Bearer synthetic-responder-secret')).toBe(
      true,
    );
    expect(serialized).not.toContain('synthetic-veteran-secret');
    expect(serialized).not.toContain('synthetic-responder-secret');
    expect(serialized).not.toContain('discard-me');
    expect(summary.safety).toMatchObject({
      deletion: 'excluded',
      export_delivery: 'excluded',
      reporting: 'excluded',
      real_world_effects: 'excluded',
      response_bodies_recorded: false,
      credentials_recorded: false,
    });
    expect(summary.verdict).toBe('PASS');
    expect(summary.capacity_claim).toBe('NOT_COMPUTABLE');
  });

  it('aggregates statuses and sanitized error categories', async () => {
    let request = 0;
    const fetchMock = vi.fn<typeof fetch>(() => {
      request += 1;
      return Promise.resolve(new Response(null, { status: request % 2 === 0 ? 503 : 401 }));
    });
    const summary = await runSoak(shortConfig(), { fetch: fetchMock, pacingMs: 1 });

    expect(summary.aggregate.statuses['401']).toBeGreaterThan(0);
    expect(summary.aggregate.statuses['503']).toBeGreaterThan(0);
    expect(summary.aggregate.errors.http_4xx).toBeGreaterThan(0);
    expect(summary.aggregate.errors.http_5xx).toBeGreaterThan(0);
    expect(summary.verdict).toBe('ERRORS_OBSERVED');
  });
});

describe('manual synthetic STAGING soak workflow', () => {
  it('is dispatch-only, uses existing E2E secrets, and pins all effect locks', async () => {
    const workflow = await readFile('.github/workflows/synthetic-staging-soak.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\bpush:/);
    expect(workflow).not.toMatch(/\bschedule:/);
    expect(workflow).toContain('SUAS_E2E_BASE_URL: ${{ vars.SUAS_E2E_BASE_URL }}');
    expect(workflow).toContain('SUAS_E2E_VETERAN_BEARER: ${{ secrets.SUAS_E2E_VETERAN_BEARER }}');
    expect(workflow).toContain(
      'SUAS_E2E_RESPONDER_BEARER: ${{ secrets.SUAS_E2E_RESPONDER_BEARER }}',
    );
    expect(workflow).toContain('D007_DELETION_EXECUTION: disabled');
    expect(workflow).toContain('D007_EXPORT_DELIVERY: disabled');
    expect(workflow).toContain('D025_REPORTING: disabled');
    expect(workflow).toContain('REAL_WORLD_EFFECTS: disabled');
    expect(workflow).toContain("default: '300'");
    expect(workflow).toContain("default: '7200'");
    expect(workflow).toContain("default: '900'");
  });
});
