/**
 * Deployed synthetic-STAGING path-parameter acceptance.
 *
 * Regression cover for the find-my-way path-parameter bug: a route such as
 * `GET /api/v0/cases/{caseId}/service-requests` answered 400 VALIDATION_FAILED
 * until SUAS #187 fixed it locally; staging was never verified. This check signs
 * in with the synthetic test account and calls the path-parameter reads directly.
 *
 * STAGING only. It reuses the `suas-synthetic-staging` host and credentials that
 * the existing acceptance workflows already use (`SUAS_E2E_BASE_URL`,
 * `SUAS_E2E_VETERAN_BEARER`, optional `SUAS_E2E_RESPONDER_BEARER`). It never
 * targets production, never records response bodies or credentials, and never
 * calls `/api/v0/dev/*` (LOCAL only; it 404s on staging).
 *
 * Identifiers are discovered at runtime from the authenticated synthetic account,
 * so no staging identifier is hardcoded.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveSyntheticStagingOrigin } from '../src/config/staging-host.js';

const DEFAULT_OUTPUT_PATH = 'artifacts/staging-path-params/summary.json';
const DEFAULT_TIMEOUT_SECONDS = 15;
const MAXIMUM_TIMEOUT_SECONDS = 60;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_ERROR_CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const UNCLASSIFIED = 'UNCLASSIFIED';
const PATH_PARAM_BUG =
  'find-my-way path-parameter bug: SUAS #187 fixed this locally and staging is unverified.';

export interface PathParamCheckConfig {
  readonly baseUrl: string;
  readonly veteranBearer: string;
  readonly responderBearer: string | undefined;
  readonly timeoutMs: number;
  readonly outputPath: string;
}

export interface PathParamCheckResult {
  readonly id: string;
  readonly method: 'GET';
  readonly path: string;
  readonly status: number;
  readonly ok: boolean;
  /** HEALTHY = 200/404; PATH_PARAM_BUG = 400; UNEXPECTED = any other status. */
  readonly outcome: 'HEALTHY' | 'PATH_PARAM_BUG' | 'UNEXPECTED';
  readonly detail: string;
}

export interface PathParamCheckSummary {
  readonly schema_version: '1';
  readonly environment: 'synthetic-STAGING';
  readonly target_origin: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly case_id: string;
  readonly case_id_source: 'veteran_open_case' | 'responder_case_list' | 'random_uuid';
  readonly checks: readonly PathParamCheckResult[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  readonly credentials_recorded: false;
  readonly response_bodies_recorded: false;
  readonly verdict: 'PASS' | 'FAIL';
}

interface ApiResponse {
  readonly status: number;
  readonly body: string;
}

function requiredBearer(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Add it to the \`suas-synthetic-staging\` GitHub Environment ` +
        '(the name staging-acceptance.yml already uses) or run `npm run seed:staging:sessions`.',
    );
  }
  return value;
}

function timeoutFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.SUAS_PATH_PARAM_TIMEOUT_SECONDS?.trim();
  const seconds = raw === undefined || raw === '' ? DEFAULT_TIMEOUT_SECONDS : Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAXIMUM_TIMEOUT_SECONDS) {
    throw new Error(
      `SUAS_PATH_PARAM_TIMEOUT_SECONDS must be greater than 0 and at most ` +
        `${MAXIMUM_TIMEOUT_SECONDS} seconds.`,
    );
  }
  return seconds * 1_000;
}

export function configFromEnv(env: NodeJS.ProcessEnv): PathParamCheckConfig {
  if (env.SUAS_ENV !== 'STAGING') {
    throw new Error('SUAS_ENV must be STAGING; this check never targets production.');
  }
  return {
    baseUrl: resolveSyntheticStagingOrigin(env.SUAS_E2E_BASE_URL, 'SUAS_E2E_BASE_URL'),
    veteranBearer: requiredBearer(env, 'SUAS_E2E_VETERAN_BEARER'),
    responderBearer: env.SUAS_E2E_RESPONDER_BEARER?.trim() || undefined,
    timeoutMs: timeoutFromEnv(env),
    outputPath: env.SUAS_PATH_PARAM_OUTPUT_PATH?.trim() || DEFAULT_OUTPUT_PATH,
  };
}

/** Released API error code from a canonical error body (API.md §6), or UNCLASSIFIED. */
export function publicErrorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown } };
    const code = parsed.error?.code;
    return typeof code === 'string' && PUBLIC_ERROR_CODE_SHAPE.test(code) ? code : UNCLASSIFIED;
  } catch {
    return UNCLASSIFIED;
  }
}

function firstUuid(candidate: unknown): string | undefined {
  return typeof candidate === 'string' && UUID_SHAPE.test(candidate) ? candidate : undefined;
}

/** Case id of the authenticated account's open case, if the deployed Worker reports one. */
export function openCaseId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { open_case?: { case_id?: unknown } };
    return firstUuid(parsed.open_case?.case_id);
  } catch {
    return undefined;
  }
}

/** First case id in an existing case-list payload, used only when no open case exists. */
export function firstCaseId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { cases?: unknown };
    if (!Array.isArray(parsed.cases)) return undefined;
    for (const entry of parsed.cases as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const found = firstUuid((entry as { case_id?: unknown }).case_id);
      if (found !== undefined) return found;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** First service request id in a case service-request list payload. */
export function firstServiceRequestId(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { service_requests?: unknown };
    if (!Array.isArray(parsed.service_requests)) return undefined;
    for (const entry of parsed.service_requests as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const found = firstUuid((entry as { service_request_id?: unknown }).service_request_id);
      if (found !== undefined) return found;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function get(
  config: PathParamCheckConfig,
  path: string,
  bearer: string | undefined,
  fetchImpl: typeof fetch,
): Promise<ApiResponse> {
  const response = await fetchImpl(new URL(path, config.baseUrl), {
    method: 'GET',
    ...(bearer === undefined ? {} : { headers: { authorization: `Bearer ${bearer}` } }),
    redirect: 'error',
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  return { status: response.status, body: await response.text() };
}

function record(
  checks: PathParamCheckResult[],
  id: string,
  path: string,
  response: ApiResponse,
): void {
  const code = response.status === 200 ? 'OK' : publicErrorCode(response.body);
  const base = { id, method: 'GET' as const, path, status: response.status };
  if (response.status === 200 || response.status === 404) {
    // 404 is healthy: the router extracted the parameter and the handler ran.
    checks.push({
      ...base,
      ok: true,
      outcome: 'HEALTHY',
      detail: `HTTP ${response.status} ${code}`,
    });
  } else if (response.status === 400) {
    checks.push({
      ...base,
      ok: false,
      outcome: 'PATH_PARAM_BUG',
      detail: `HTTP 400 ${code} (${PATH_PARAM_BUG})`,
    });
  } else {
    checks.push({
      ...base,
      ok: false,
      outcome: 'UNEXPECTED',
      detail: `HTTP ${response.status} ${code}`,
    });
  }
}

export async function runPathParamChecks(
  config: PathParamCheckConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PathParamCheckSummary> {
  const startedAt = new Date();
  const checks: PathParamCheckResult[] = [];
  const skipped: { id: string; reason: string }[] = [];

  // "Sign in": the bearer is the synthetic session minted by the existing
  // `seed:staging:sessions` step; a rejected credential is a configuration
  // failure, not a skip.
  const veteran = await get(config, '/api/v0/veterans/me', config.veteranBearer, fetchImpl);
  if (veteran.status === 401) {
    throw new Error(
      'SUAS_E2E_VETERAN_BEARER was rejected with 401 UNAUTHENTICATED. Refresh the synthetic ' +
        'STAGING sessions (`npm run seed:staging:sessions`, as staging-acceptance.yml does).',
    );
  }
  if (veteran.status !== 200) {
    throw new Error(
      `GET /api/v0/veterans/me returned ${veteran.status} ${publicErrorCode(veteran.body)}; ` +
        'the synthetic STAGING veteran session is not usable.',
    );
  }

  // Case id: the veteran's own open case, else a responder-visible case (read with
  // the responder bearer, since a veteran cannot see another veteran's case), else a
  // random UUID for which 404 NOT_FOUND is the healthy answer.
  let caseId = openCaseId(veteran.body);
  let caseIdSource: PathParamCheckSummary['case_id_source'] = 'veteran_open_case';
  let caseBearer = config.veteranBearer;
  if (caseId === undefined && config.responderBearer !== undefined) {
    const cases = await get(
      config,
      '/api/v0/cases?ownership=unassigned&limit=20',
      config.responderBearer,
      fetchImpl,
    );
    caseId = cases.status === 200 ? firstCaseId(cases.body) : undefined;
    if (caseId !== undefined) {
      caseIdSource = 'responder_case_list';
      caseBearer = config.responderBearer;
    }
  }
  if (caseId === undefined) {
    caseId = randomUUID();
    caseIdSource = 'random_uuid';
    caseBearer = config.veteranBearer;
  }

  // Mandatory: the path-parameter route that SUAS #187 fixed locally.
  const caseServiceRequestsPath = `/api/v0/cases/${caseId}/service-requests`;
  const caseServiceRequests = await get(config, caseServiceRequestsPath, caseBearer, fetchImpl);
  record(checks, 'case_service_requests', caseServiceRequestsPath, caseServiceRequests);

  // Secondary path-parameter read: a discovered id, else a random UUID (404 healthy).
  const serviceRequestId =
    (caseServiceRequests.status === 200
      ? firstServiceRequestId(caseServiceRequests.body)
      : undefined) ?? randomUUID();
  const detailPath = `/api/v0/service-requests/${serviceRequestId}`;
  record(
    checks,
    'service_request_detail',
    detailPath,
    await get(config, detailPath, caseBearer, fetchImpl),
  );

  return {
    schema_version: '1',
    environment: 'synthetic-STAGING',
    target_origin: config.baseUrl,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    case_id: caseId,
    case_id_source: caseIdSource,
    checks,
    skipped,
    credentials_recorded: false,
    response_bodies_recorded: false,
    verdict: checks.every((check) => check.ok) ? 'PASS' : 'FAIL',
  };
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  const config = configFromEnv(env);
  const summary = await runPathParamChecks(config, fetchImpl);
  for (const check of summary.checks) {
    const outcome = check.ok ? 'PASS' : 'FAIL';
    console.log(`${outcome} [${check.outcome}] ${check.id} GET ${check.path} -> ${check.detail}`);
  }
  const bugs = summary.checks.filter((check) => check.outcome === 'PATH_PARAM_BUG').length;
  const unexpected = summary.checks.filter((check) => check.outcome === 'UNEXPECTED').length;
  console.log(
    `case_id_source=${summary.case_id_source} path_param_bug(400)=${bugs} unexpected_status=${unexpected}`,
  );
  for (const skip of summary.skipped) {
    console.log(`SKIP ${skip.id}: ${skip.reason}`);
  }
  console.log(`path-param check ${summary.verdict} against ${summary.target_origin}`);
  await mkdir(dirname(config.outputPath), { recursive: true });
  await writeFile(config.outputPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  if (summary.verdict !== 'PASS') process.exitCode = 1;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Path-parameter check failed.');
    process.exitCode = 1;
  });
}
