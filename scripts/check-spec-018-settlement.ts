/**
 * Mechanical SPEC-018 settlement gate.
 *
 * Fails unless scratch evidence is synced to the current git HEAD:
 * - full-verify.log first line stamps that HEAD and ends with FULL_VERIFY_OK
 * - OpenAPI operation count in the log matches docs/openapi/v0.json
 * - readiness docs show OUTCOME SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET
 *   and do not claim Plane A JSON is still a CODE_FIXABLE gap
 * - ci-run.txt cites a green Actions run whose headSha is that HEAD
 *
 * Scratch root: SUAS_SETTLE_SCRATCH or /tmp/grok-goal-b26a2796bc90/implementer
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_COMMANDS, type CaseCommand } from '../src/coordination/case-transitions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = process.env.SUAS_SETTLE_SCRATCH ?? '/tmp/grok-goal-b26a2796bc90/implementer';

const STALE_READINESS_PATTERNS = [
  /Still missing vs APIS\.md Plane A drafts:.*notifications/i,
  /Remaining Plane A JSON \(notifications/i,
  /Domain present; JSON projection incomplete/i,
  /Consent grant\/revoke command JSON still thin/i,
  /Service-request command JSON; durable async/i,
  /finishes remaining released Plane A JSON/i,
  /createSettlement.*CODE_FIXABLE/i,
  /Still CODE_FIXABLE \(named residual\): `createSettlement`/i,
  /Owner decides D-022/i,
  /STAGING\/PRODUCTION fail-closed pending D-022/i,
  /Owner decides D-007 retention\/deletion durations/i,
  /D-007 durations and staging rehearsal remain/i,
];

/**
 * CASE_COMMANDS that may stay domain-only. Each entry needs a one-line cite.
 * Empty = every released case command must have POST /api/v0/.../commands/<kebab>.
 */
const INTENTIONALLY_DEFERRED_CASE_COMMANDS: Readonly<Partial<Record<CaseCommand, string>>> = {};

/** Map CASES.md command enum → OpenAPI kebab path segment. */
const CASE_COMMAND_KEBAB: Readonly<Record<CaseCommand, string>> = {
  TRIAGE: 'triage',
  CLAIM_CASE: 'claim',
  ASSIGN_CASE: 'assign',
  ACTIVATE: 'activate',
  MOVE_TO_FOLLOWUP: 'move-to-followup',
  RESUME_ACTIVE: 'resume-active',
  ESCALATE: 'escalate',
  RESOLVE: 'resolve',
  CLOSE: 'close',
  REOPEN: 'reopen',
};

/**
 * Non-case released domain commands that must have matching OpenAPI `/api/v0` routes.
 * Case commands are asserted from CASE_COMMANDS (source of truth).
 */
const REQUIRED_OPENAPI_ROUTES: readonly { method: string; path: string; reason: string }[] = [
  {
    method: 'post',
    path: '/api/v0/trusted-contacts/{id}/commands/accept',
    reason: 'acceptTrustedContact (TRUSTED_CIRCLE.md §3.4)',
  },
  {
    method: 'post',
    path: '/api/v0/cases/{caseId}/commands/log-contact-attempt',
    reason: 'recordContact log-contact-attempt (RESPONDER_WORKFLOWS.md §7)',
  },
  {
    method: 'post',
    path: '/api/v0/cases/{caseId}/commands/complete-contact',
    reason: 'recordContact complete-contact (RESPONDER_WORKFLOWS.md §7)',
  },
  {
    method: 'get',
    path: '/api/v0/cases/{id}/settlements',
    reason: 'listSettlements (API.md §9)',
  },
  {
    method: 'get',
    path: '/api/v0/cases/{id}/settlements/{settlement_id}',
    reason: 'findSettlement (API.md §9)',
  },
];

function fail(message: string): never {
  console.error(`settle:check FAILED: ${message}`);
  process.exit(1);
}

function gitHead(): string {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

function loadOpenApi(): { paths: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(root, 'docs/openapi/v0.json'), 'utf8')) as {
    paths: Record<string, Record<string, unknown>>;
  };
}

function openApiOperationCount(): number {
  const document = loadOpenApi();
  let count = 0;
  for (const methods of Object.values(document.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      if (method.startsWith('x-') || method === 'parameters') continue;
      count += 1;
    }
  }
  return count;
}

function assertRequiredOpenApiRoutes(): void {
  const document = loadOpenApi();
  for (const required of REQUIRED_OPENAPI_ROUTES) {
    const methods = document.paths[required.path];
    if (methods === undefined || methods[required.method] === undefined) {
      fail(
        `OpenAPI missing ${required.method.toUpperCase()} ${required.path} required for ${required.reason}`,
      );
    }
  }

  for (const command of CASE_COMMANDS) {
    const deferred = INTENTIONALLY_DEFERRED_CASE_COMMANDS[command];
    if (deferred !== undefined) continue;
    const kebab = CASE_COMMAND_KEBAB[command];
    const path = `/api/v0/cases/{id}/commands/${kebab}`;
    const methods = document.paths[path];
    if (methods === undefined || methods.post === undefined) {
      fail(
        `OpenAPI missing POST ${path} required for CASE_COMMANDS.${command} (CASES.md §4). ` +
          `Add the route or cite INTENTIONALLY_DEFERRED_CASE_COMMANDS.`,
      );
    }
  }
}

/** HTTP contract suites must not bypass missing surfaces via domain executeCaseCommand. */
function assertNoHttpSettlementDomainBypass(): void {
  const settlementHttp = readFileSync(
    join(root, 'tests/integration/http-settlement.test.ts'),
    'utf8',
  );
  if (/\bexecuteCaseCommand\b/.test(settlementHttp)) {
    fail(
      'tests/integration/http-settlement.test.ts must not call executeCaseCommand; ' +
        'claim→activate→resolve must use /api/v0 only',
    );
  }
}

function assertReadinessDocs(): void {
  const finalReport = readFileSync(join(root, 'docs/readiness/SPEC-018-final-report.md'), 'utf8');
  if (!/^## OUTCOME\s*\n\s*\n`SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET`/m.test(finalReport)) {
    // Also accept exact line after OUTCOME heading
    const outcomeMatch = finalReport.match(/## OUTCOME\s*\n+`([^`]+)`/);
    if (outcomeMatch?.[1] !== 'SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET') {
      fail(
        `SPEC-018-final-report.md OUTCOME must be SPEC_018_BLOCKED_WITH_MINIMAL_RESIDUAL_SET (got ${outcomeMatch?.[1] ?? 'missing'})`,
      );
    }
  }

  for (const relative of [
    'docs/readiness/change-map.md',
    'docs/readiness/SPEC-018-plan.md',
    'docs/readiness/SPEC-018-final-report.md',
    'docs/readiness/security-privacy-audit.md',
  ]) {
    const text = readFileSync(join(root, relative), 'utf8');
    for (const pattern of STALE_READINESS_PATTERNS) {
      if (pattern.test(text)) {
        fail(`${relative} still contains a stale readiness claim: ${pattern}`);
      }
    }
  }
}

function assertFullVerify(head: string, expectedOps: number): void {
  const path = join(scratch, 'full-verify.log');
  if (!existsSync(path)) fail(`missing ${path}`);
  const text = readFileSync(path, 'utf8');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const expected = `=== HEAD ${head} ===`;
  if (firstLine !== expected) {
    fail(`full-verify.log first line must be "${expected}" (got "${firstLine}")`);
  }
  if (!text.includes('=== FULL_VERIFY_OK ===')) {
    fail('full-verify.log missing === FULL_VERIFY_OK ===');
  }
  const openapiLine = [...text.split(/\r?\n/)]
    .reverse()
    .find((line) => line.includes('openapi drift check ok:'));
  if (openapiLine === undefined) {
    fail('full-verify.log missing openapi drift check ok line');
  }
  const match = openapiLine.match(/openapi drift check ok:\s+(\d+)\s+\/api\/v0 routes/);
  if (match === null) {
    fail(`could not parse openapi count from: ${openapiLine}`);
  }
  const logged = Number(match[1]);
  if (logged !== expectedOps) {
    fail(
      `openapi count in full-verify.log is ${logged}, docs/openapi/v0.json has ${expectedOps} operations`,
    );
  }
}

function assertCiRun(head: string): void {
  const path = join(scratch, 'ci-run.txt');
  if (!existsSync(path)) fail(`missing ${path}`);
  const text = readFileSync(path, 'utf8');
  const urls = [
    ...text.matchAll(/https:\/\/github\.com\/scrimshawlife-ctrl\/suas\/actions\/runs\/(\d+)/g),
  ].map((match) => match[0]);
  if (urls.length === 0) fail('ci-run.txt has no Actions run URLs');

  const shortHead = head.slice(0, 7);
  let matched = false;
  for (const url of [...new Set(urls)].reverse()) {
    const runId = url.split('/').pop();
    if (runId === undefined) continue;
    try {
      const raw = execFileSync(
        'gh',
        [
          'run',
          'view',
          runId,
          '--repo',
          'scrimshawlife-ctrl/suas',
          '--json',
          'conclusion,headSha,url,status',
        ],
        { encoding: 'utf8' },
      );
      const run = JSON.parse(raw) as {
        conclusion: string;
        headSha: string;
        status: string;
        url: string;
      };
      if (run.conclusion === 'success' && run.status === 'completed' && run.headSha === head) {
        matched = true;
        console.log(`settle:check CI match ${run.url} headSha=${run.headSha}`);
        break;
      }
      if (run.headSha.startsWith(shortHead) && run.conclusion === 'success') {
        matched = true;
        console.log(`settle:check CI match ${run.url} headSha=${run.headSha}`);
        break;
      }
    } catch (error) {
      console.error(`settle:check warning: could not inspect ${url}: ${String(error)}`);
    }
  }
  if (!matched) {
    fail(
      `ci-run.txt has no green Actions run whose headSha equals ${head}. Append the main push CI for this commit.`,
    );
  }
}

function main(): void {
  const head = gitHead();
  const ops = openApiOperationCount();
  console.log(`settle:check HEAD=${head} openapi_operations=${ops} scratch=${scratch}`);
  assertFullVerify(head, ops);
  assertRequiredOpenApiRoutes();
  assertNoHttpSettlementDomainBypass();
  assertReadinessDocs();
  assertCiRun(head);
  console.log('settle:check OK');
}

main();
