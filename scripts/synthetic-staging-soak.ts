import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { resolveSyntheticStagingOrigin } from '../src/config/staging-host.js';

const CONFIRMATION = 'synthetic-staging-read-only';
const DEFAULT_OUTPUT = 'artifacts/soak/synthetic-staging-soak-summary.json';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_PACING_MS = 1_000;

/**
 * GET-only client retries for transient synthetic-STAGING platform statuses.
 * 503 is the Worker isolate/Hyperdrive not-ready and Cloudflare edge path.
 * 500 is the Worker leftover-I/O / unhandled request-path fallback.
 * This is soak-harness transport hardening, not a product SLO or capacity claim.
 */
export const TRANSIENT_GET_RETRY = Object.freeze({
  statuses: Object.freeze([503, 500]),
  maxAttempts: 3,
  delayMs: 200,
});

export const CANONICAL_SOAK_PROFILE = Object.freeze({
  warmup: { durationSeconds: 5 * 60, virtualUsers: 1 },
  steady: { durationSeconds: 120 * 60, virtualUsers: 5 },
  peak: { durationSeconds: 15 * 60, virtualUsers: 10 },
  drainSeconds: 15 * 60,
});

const SAFETY_LOCKS = Object.freeze({
  D007_DELETION_EXECUTION: 'disabled',
  D007_EXPORT_DELIVERY: 'disabled',
  D007_365_DAY_PURGE: 'disabled',
  D025_REPORTING: 'disabled',
  REAL_WORLD_EFFECTS: 'disabled',
  PILOT_LAUNCH: 'blocked',
  PRODUCTION_LAUNCH: 'blocked',
  SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
  SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
});

type PhaseName = 'warmup' | 'steady' | 'peak';
type CredentialName = 'public' | 'veteran' | 'responder';
type ErrorCategory = 'timeout' | 'network' | 'drain_aborted' | 'http_4xx' | 'http_5xx';

interface FixedRequest {
  readonly id: string;
  readonly path: string;
  readonly credential: CredentialName;
}

const FIXED_READ_ONLY_REQUESTS: readonly FixedRequest[] = Object.freeze([
  { id: 'health', path: '/api/v0/health', credential: 'public' },
  { id: 'resource_catalog', path: '/api/v0/resources?limit=20', credential: 'veteran' },
  { id: 'veteran_self', path: '/api/v0/veterans/me', credential: 'veteran' },
  {
    id: 'responder_unassigned_cases',
    path: '/api/v0/cases?ownership=unassigned&limit=20',
    credential: 'responder',
  },
]);

export interface SoakConfig {
  readonly baseUrl: string;
  readonly veteranBearer: string;
  readonly responderBearer: string;
  readonly warmupDurationMs: number;
  readonly steadyDurationMs: number;
  readonly peakDurationMs: number;
  readonly drainDurationMs: number;
  readonly requestTimeoutMs: number;
  readonly outputPath: string;
}

interface Aggregate {
  requests: number;
  statuses: Record<string, number>;
  publicErrorCodes: Record<string, number>;
  errors: Record<ErrorCategory, number>;
  latenciesMs: number[];
}

export interface SanitizedAggregate {
  readonly requests: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly public_error_codes: Readonly<Record<string, number>>;
  readonly errors: Readonly<Record<ErrorCategory, number>>;
  readonly latency_ms: {
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
  };
}

export interface SoakSummary {
  readonly schema_version: '1';
  readonly environment: 'synthetic-STAGING';
  readonly target_origin: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly fixed_profile: {
    readonly method: 'GET';
    readonly request_ids: readonly string[];
    readonly pacing_ms: number;
    readonly phases: readonly {
      readonly name: PhaseName;
      readonly duration_seconds: number;
      readonly virtual_users: number;
    }[];
    readonly drain_seconds: number;
  };
  readonly safety: {
    readonly deletion: 'excluded';
    readonly export_delivery: 'excluded';
    readonly reporting: 'excluded';
    readonly real_world_effects: 'excluded';
    readonly response_bodies_recorded: false;
    readonly credentials_recorded: false;
  };
  readonly aggregate: SanitizedAggregate;
  readonly by_phase: Readonly<Record<PhaseName, SanitizedAggregate>>;
  readonly by_request: Readonly<Record<string, SanitizedAggregate>>;
  readonly drain: { readonly elapsed_ms: number; readonly forced_aborts: number };
  readonly retry: {
    readonly max_attempts_per_request: number;
    readonly retried_statuses: readonly number[];
    readonly recovered: number;
    readonly exhausted: number;
    readonly statuses: Readonly<Record<string, number>>;
  };
  readonly verdict: 'PASS' | 'ERRORS_OBSERVED';
  readonly capacity_claim: 'NOT_COMPUTABLE';
}

interface RunDependencies {
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly wallClock: () => Date;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly pacingMs: number;
}

function emptyAggregate(): Aggregate {
  return {
    requests: 0,
    statuses: {},
    publicErrorCodes: {},
    errors: { timeout: 0, network: 0, drain_aborted: 0, http_4xx: 0, http_5xx: 0 },
    latenciesMs: [],
  };
}

function positiveDuration(
  env: NodeJS.ProcessEnv,
  name: string,
  defaultSeconds: number,
  maximumSeconds: number,
): number {
  const raw = env[name]?.trim();
  const seconds = raw === undefined || raw === '' ? defaultSeconds : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > maximumSeconds) {
    throw new Error(`${name} must be greater than 0 and no more than ${maximumSeconds} seconds.`);
  }
  return seconds * 1_000;
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required and must contain a synthetic bearer credential.`);
  return value;
}

export function configFromEnv(env: NodeJS.ProcessEnv): SoakConfig {
  if (env.SUAS_ENV !== 'STAGING') {
    throw new Error('SUAS_ENV must be STAGING for the synthetic-STAGING soak.');
  }
  if (env.SUAS_SOAK_CONFIRM !== CONFIRMATION) {
    throw new Error(`SUAS_SOAK_CONFIRM must equal ${CONFIRMATION}.`);
  }
  for (const [name, expected] of Object.entries(SAFETY_LOCKS)) {
    if (env[name] !== expected) throw new Error(`${name} must equal ${expected}.`);
  }

  return {
    baseUrl: resolveSyntheticStagingOrigin(env.SUAS_E2E_BASE_URL, 'SUAS_E2E_BASE_URL'),
    veteranBearer: requiredSecret(env, 'SUAS_E2E_VETERAN_BEARER'),
    responderBearer: requiredSecret(env, 'SUAS_E2E_RESPONDER_BEARER'),
    warmupDurationMs: positiveDuration(
      env,
      'SUAS_SOAK_WARMUP_SECONDS',
      CANONICAL_SOAK_PROFILE.warmup.durationSeconds,
      CANONICAL_SOAK_PROFILE.warmup.durationSeconds,
    ),
    steadyDurationMs: positiveDuration(
      env,
      'SUAS_SOAK_STEADY_SECONDS',
      CANONICAL_SOAK_PROFILE.steady.durationSeconds,
      CANONICAL_SOAK_PROFILE.steady.durationSeconds,
    ),
    peakDurationMs: positiveDuration(
      env,
      'SUAS_SOAK_PEAK_SECONDS',
      CANONICAL_SOAK_PROFILE.peak.durationSeconds,
      CANONICAL_SOAK_PROFILE.peak.durationSeconds,
    ),
    drainDurationMs: positiveDuration(
      env,
      'SUAS_SOAK_DRAIN_SECONDS',
      CANONICAL_SOAK_PROFILE.drainSeconds,
      CANONICAL_SOAK_PROFILE.drainSeconds,
    ),
    requestTimeoutMs: positiveDuration(
      env,
      'SUAS_SOAK_REQUEST_TIMEOUT_SECONDS',
      DEFAULT_REQUEST_TIMEOUT_MS / 1_000,
      60,
    ),
    outputPath: env.SUAS_SOAK_OUTPUT_PATH?.trim() || DEFAULT_OUTPUT,
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function sanitized(aggregate: Aggregate): SanitizedAggregate {
  const latencies = aggregate.latenciesMs.toSorted((left, right) => left - right);
  const rounded = (value: number): number => Number(value.toFixed(2));
  return {
    requests: aggregate.requests,
    statuses: { ...aggregate.statuses },
    public_error_codes: { ...aggregate.publicErrorCodes },
    errors: { ...aggregate.errors },
    latency_ms: {
      p50: rounded(percentile(latencies, 50)),
      p95: rounded(percentile(latencies, 95)),
      p99: rounded(percentile(latencies, 99)),
      max: rounded(latencies.at(-1) ?? 0),
    },
  };
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function addObservation(
  aggregates: readonly Aggregate[],
  status: number | undefined,
  latencyMs: number,
  error: ErrorCategory | undefined,
  publicErrorCode: string | undefined,
): void {
  for (const aggregate of aggregates) {
    aggregate.requests += 1;
    aggregate.latenciesMs.push(latencyMs);
    if (status !== undefined) increment(aggregate.statuses, String(status));
    if (publicErrorCode !== undefined) increment(aggregate.publicErrorCodes, publicErrorCode);
    if (error !== undefined) aggregate.errors[error] += 1;
  }
}

function publicErrorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed.error?.code;
    return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNCLASSIFIED';
  } catch {
    return 'UNCLASSIFIED';
  }
}

function credential(config: SoakConfig, name: CredentialName): string | undefined {
  if (name === 'veteran') return config.veteranBearer;
  if (name === 'responder') return config.responderBearer;
  return undefined;
}

function totalErrors(aggregate: Aggregate): number {
  return Object.values(aggregate.errors).reduce((total, count) => total + count, 0);
}

async function sleepOrAbort(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return;
  await Promise.race([
    sleep(milliseconds),
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    }),
  ]);
}

export async function runSoak(
  config: SoakConfig,
  overrides: Partial<RunDependencies> = {},
): Promise<SoakSummary> {
  const dependencies: RunDependencies = {
    fetch: globalThis.fetch,
    now: () => performance.now(),
    wallClock: () => new Date(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    pacingMs: REQUEST_PACING_MS,
    ...overrides,
  };
  const startedAt = dependencies.wallClock();
  const aggregate = emptyAggregate();
  const byPhase: Record<PhaseName, Aggregate> = {
    warmup: emptyAggregate(),
    steady: emptyAggregate(),
    peak: emptyAggregate(),
  };
  const byRequest = Object.fromEntries(
    FIXED_READ_ONLY_REQUESTS.map((request) => [request.id, emptyAggregate()]),
  ) as Record<string, Aggregate>;
  const activeControllers = new Set<AbortController>();
  let draining = false;
  let forcedAborts = 0;
  let recoveredRetries = 0;
  let exhaustedRetries = 0;
  const retryAttemptStatuses: Record<string, number> = {};
  const retryableStatuses = new Set<number>(TRANSIENT_GET_RETRY.statuses);

  const execute = async (phase: PhaseName, request: FixedRequest): Promise<void> => {
    const requestAggregate = byRequest[request.id] as Aggregate;
    const targets = [aggregate, byPhase[phase], requestAggregate] as const;
    let attempts = 0;
    let retried = false;

    while (attempts < TRANSIENT_GET_RETRY.maxAttempts) {
      if (draining) break;
      attempts += 1;
      const started = dependencies.now();
      let status: number | undefined;
      let error: ErrorCategory | undefined;
      let observedPublicErrorCode: string | undefined;
      const controller = new AbortController();
      activeControllers.add(controller);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.requestTimeoutMs);
      let retryThis = false;
      try {
        const bearer = credential(config, request.credential);
        const response = await dependencies.fetch(new URL(request.path, config.baseUrl), {
          method: 'GET',
          ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
          redirect: 'error',
          signal: controller.signal,
        });
        status = response.status;
        if (status >= 400) {
          observedPublicErrorCode = publicErrorCode(await response.text());
          if (status >= 500) {
            retryThis =
              retryableStatuses.has(status) &&
              attempts < TRANSIENT_GET_RETRY.maxAttempts &&
              !draining;
            error = retryThis ? undefined : 'http_5xx';
          } else {
            error = 'http_4xx';
          }
        } else {
          await response.arrayBuffer();
        }
      } catch {
        error = timedOut ? 'timeout' : draining ? 'drain_aborted' : 'network';
      } finally {
        clearTimeout(timeout);
        activeControllers.delete(controller);
      }

      addObservation(targets, status, dependencies.now() - started, error, observedPublicErrorCode);

      if (!retryThis) {
        if (retried && error === undefined) recoveredRetries += 1;
        if (retried && error !== undefined) exhaustedRetries += 1;
        break;
      }

      retried = true;
      if (status !== undefined) increment(retryAttemptStatuses, String(status));

      const delayController = new AbortController();
      activeControllers.add(delayController);
      try {
        await sleepOrAbort(dependencies.sleep, TRANSIENT_GET_RETRY.delayMs, delayController.signal);
      } finally {
        activeControllers.delete(delayController);
      }
      if (draining || delayController.signal.aborted) {
        for (const target of targets) target.errors.http_5xx += 1;
        exhaustedRetries += 1;
        break;
      }
    }
  };

  const phaseDefinitions = [
    {
      name: 'warmup' as const,
      durationMs: config.warmupDurationMs,
      virtualUsers: CANONICAL_SOAK_PROFILE.warmup.virtualUsers,
    },
    {
      name: 'steady' as const,
      durationMs: config.steadyDurationMs,
      virtualUsers: CANONICAL_SOAK_PROFILE.steady.virtualUsers,
    },
    {
      name: 'peak' as const,
      durationMs: config.peakDurationMs,
      virtualUsers: CANONICAL_SOAK_PROFILE.peak.virtualUsers,
    },
  ];

  let drainElapsedMs = 0;
  for (const phase of phaseDefinitions) {
    const deadline = dependencies.now() + phase.durationMs;
    const workers = Array.from({ length: phase.virtualUsers }, (_, virtualUser) =>
      (async () => {
        let iteration = 0;
        while (dependencies.now() < deadline) {
          const request =
            FIXED_READ_ONLY_REQUESTS[(virtualUser + iteration) % FIXED_READ_ONLY_REQUESTS.length];
          if (request === undefined) throw new Error('Fixed request profile is empty.');
          await execute(phase.name, request);
          iteration += 1;
          const remaining = deadline - dependencies.now();
          if (remaining > 0) await dependencies.sleep(Math.min(dependencies.pacingMs, remaining));
        }
      })(),
    );

    if (phase.name !== 'peak') {
      await Promise.all(workers);
      continue;
    }

    const drainStarted = dependencies.now();
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const drainExpired = new Promise<'expired'>((resolve) => {
      drainTimer = setTimeout(() => resolve('expired'), phase.durationMs + config.drainDurationMs);
    });
    const completed = Promise.all(workers).then(() => 'completed' as const);
    const outcome = await Promise.race([completed, drainExpired]);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    if (outcome === 'expired') {
      draining = true;
      forcedAborts = activeControllers.size;
      for (const controller of activeControllers) controller.abort();
      await completed;
    }
    drainElapsedMs = Math.max(0, dependencies.now() - deadline);
    if (drainElapsedMs === 0)
      drainElapsedMs = Math.max(0, dependencies.now() - drainStarted - phase.durationMs);
  }

  const finishedAt = dependencies.wallClock();
  const summary: SoakSummary = {
    schema_version: '1',
    environment: 'synthetic-STAGING',
    target_origin: config.baseUrl,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    fixed_profile: {
      method: 'GET',
      request_ids: FIXED_READ_ONLY_REQUESTS.map((request) => request.id),
      pacing_ms: dependencies.pacingMs,
      phases: phaseDefinitions.map((phase) => ({
        name: phase.name,
        duration_seconds: phase.durationMs / 1_000,
        virtual_users: phase.virtualUsers,
      })),
      drain_seconds: config.drainDurationMs / 1_000,
    },
    safety: {
      deletion: 'excluded',
      export_delivery: 'excluded',
      reporting: 'excluded',
      real_world_effects: 'excluded',
      response_bodies_recorded: false,
      credentials_recorded: false,
    },
    aggregate: sanitized(aggregate),
    by_phase: {
      warmup: sanitized(byPhase.warmup),
      steady: sanitized(byPhase.steady),
      peak: sanitized(byPhase.peak),
    },
    by_request: Object.fromEntries(
      Object.entries(byRequest).map(([name, requestAggregate]) => [
        name,
        sanitized(requestAggregate),
      ]),
    ),
    drain: { elapsed_ms: Number(drainElapsedMs.toFixed(2)), forced_aborts: forcedAborts },
    retry: {
      max_attempts_per_request: TRANSIENT_GET_RETRY.maxAttempts,
      retried_statuses: [...TRANSIENT_GET_RETRY.statuses],
      recovered: recoveredRetries,
      exhausted: exhaustedRetries,
      statuses: { ...retryAttemptStatuses },
    },
    verdict: totalErrors(aggregate) === 0 ? 'PASS' : 'ERRORS_OBSERVED',
    capacity_claim: 'NOT_COMPUTABLE',
  };
  return summary;
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = configFromEnv(env);
  const summary = await runSoak(config);
  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.verdict !== 'PASS') process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Synthetic STAGING soak failed.');
    process.exitCode = 1;
  });
}
