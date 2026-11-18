/**
 * staging-deploy.yml's gate: before any job builds or reaches AWS, the deploy refuses a SHA that
 * is not a full commit on main and any deployment variable that is missing or malformed. Runs the
 * gate step's own shell block with bash in a throwaway git repository.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/staging-deploy.yml', import.meta.url),
  'utf8',
);
const GATE_STEP = 'Require a commit on main and the deployment variables';

// The lines of a step, from its `- name:` to the next sibling step or job.
function stepLines(name: string): string[] {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  const indent = lines[start]!.indexOf('-');
  const end = lines.findIndex(
    (line, at) =>
      at > start && line.trim() !== '' && line.length - line.trimStart().length <= indent,
  );
  return lines.slice(start, end === -1 ? undefined : end);
}

// The step's `run: |` block, dedented.
function runBlock(name: string): string {
  const lines = stepLines(name);
  const body = lines.slice(lines.findIndex((line) => line.trim() === 'run: |') + 1);
  const indent = body[0]!.length - body[0]!.trimStart().length;
  return body.map((line) => line.slice(indent)).join('\n');
}

const repo = mkdtempSync(join(tmpdir(), 'suas-deploy-gate-'));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) =>
  spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args], {
    encoding: 'utf8',
  }).stdout.trim();
git('init', '-q');
git('commit', '-q', '--allow-empty', '-m', 'main');
const ON_MAIN = git('rev-parse', 'HEAD');
git('update-ref', 'refs/remotes/origin/main', 'HEAD');
git('commit', '-q', '--allow-empty', '-m', 'not on main');
const OFF_MAIN = git('rev-parse', 'HEAD');

const ACCOUNT = '123456789012';
const VALID = {
  INPUT_SHA: ON_MAIN,
  AWS_ACCOUNT_ID: ACCOUNT,
  AWS_PLAN_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/suas-gha-staging-plan`,
  AWS_DEPLOY_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/suas-gha-staging-deploy`,
  SUAS_STAGING_API_ORIGIN: 'https://api.staging.example.org',
  SUAS_STAGING_WEB_ORIGIN: 'https://staging.example.org',
};

const gate = (overrides: Partial<typeof VALID>) =>
  spawnSync('bash', ['-e', '-c', runBlock(GATE_STEP)], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: join(repo, 'github-output'),
      ...VALID,
      ...overrides,
    },
  }).status;

describe('staging-deploy.yml gate', () => {
  it('reads every variable it checks from the repository variables', () => {
    const step = stepLines(GATE_STEP).join('\n');
    for (const name of Object.keys(VALID).filter((key) => key !== 'INPUT_SHA')) {
      expect(step).toContain(`${name}: \${{ vars.${name} }}`);
    }
  });

  it('accepts a full SHA on main with every variable set', () => {
    expect(gate({})).toBe(0);
  });

  it.each<[string, Partial<typeof VALID>]>([
    ['a commit not on main', { INPUT_SHA: OFF_MAIN }],
    ['a branch name', { INPUT_SHA: 'main' }],
    ['a role in another account', { AWS_DEPLOY_ROLE_ARN: 'arn:aws:iam::210987654321:role/x' }],
    ['no API origin', { SUAS_STAGING_API_ORIGIN: '' }],
    ['no web origin', { SUAS_STAGING_WEB_ORIGIN: '' }],
    ['a plain-http web origin', { SUAS_STAGING_WEB_ORIGIN: 'http://staging.example.org' }],
    ['a web origin with a path', { SUAS_STAGING_WEB_ORIGIN: 'https://staging.example.org/x' }],
    ['a script URL as web origin', { SUAS_STAGING_WEB_ORIGIN: 'javascript:alert(1)' }],
  ])('refuses %s', (_case, overrides) => {
    expect(gate(overrides)).not.toBe(0);
  });
});
