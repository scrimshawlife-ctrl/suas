import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The GitHub OIDC trust policies in infra/bootstrap/github-oidc.yaml, evaluated against token
// claims. Read as text like the workflow tests: each role's StringEquals map, with !Sub resolved.
const TEMPLATE = readFileSync(new URL('../bootstrap/github-oidc.yaml', import.meta.url), 'utf8');
const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/staging-deploy-verified.yml', import.meta.url),
  'utf8',
);
const PARAMS: Record<string, string> = {
  SubjectPrefix: 'repo:octo@1/suas@2',
  WorkflowRepository: 'octo/suas',
};
const DEPLOY_WORKFLOW = 'octo/suas/.github/workflows/staging-deploy-verified.yml@refs/heads/main';

function trustConditions(role: 'PlanRole' | 'DeployRole'): Record<string, string> {
  const block = TEMPLATE.split(/^ {2}(?=\w+:$)/m).find((b) => b.startsWith(`${role}:`)) ?? '';
  const conditions = block.split('StringEquals:')[1]?.split('Policies:')[0] ?? '';
  return Object.fromEntries(
    [...conditions.matchAll(/token\.actions\.githubusercontent\.com:(\w+): (.+)/g)].map(
      ([, key, raw]) => [
        key,
        raw!.replace(/^!Sub /, '').replace(/\$\{(\w+)\}/g, (_, name: string) => PARAMS[name]!),
      ],
    ),
  );
}

const trusts = (role: 'PlanRole' | 'DeployRole', claims: Record<string, string>) =>
  Object.entries(trustConditions(role)).every(([key, value]) => claims[key] === value);

const token = (environment: string, jobWorkflowRef = DEPLOY_WORKFLOW) => ({
  aud: 'sts.amazonaws.com',
  sub: `${PARAMS.SubjectPrefix}:environment:${environment}`,
  job_workflow_ref: jobWorkflowRef,
});

describe('GitHub OIDC trust', () => {
  it('issues the workflow claim from a called workflow and retains manual-only entry', () => {
    const entry = readFileSync(
      new URL('../../.github/workflows/staging-deploy.yml', import.meta.url),
      'utf8',
    );
    expect(entry).toMatch(/on:\n  workflow_dispatch:/);
    expect(entry).toContain('uses: ./.github/workflows/staging-deploy-verified.yml');
    expect(entry).toContain('id-token: write');
    expect(entry).toContain('secrets: inherit');
    expect(entry).toContain('cancel-in-progress: false');
    expect(WORKFLOW).toMatch(/on:\n  workflow_call:/);
    expect(WORKFLOW).not.toContain('workflow_dispatch:');
    // Credentialed jobs are downstream of the caller/commit guard and retain their environments.
    expect(WORKFLOW).toMatch(/plan:\n    needs: \[gate, build\]/);
    expect(WORKFLOW).toMatch(/deploy:\n    needs: \[gate, plan\]/);
    expect(WORKFLOW).toContain('uses: ./.github/workflows/verify.yml');
  });
  it.each([
    ['DeployRole', 'suas-synthetic-staging'],
    ['PlanRole', 'suas-synthetic-staging-plan'],
  ] as const)('%s trusts only staging-deploy-verified.yml on main in %s', (role, environment) => {
    expect(trusts(role, token(environment))).toBe(true);
    // Any other workflow file that names the environment, or a branch copy of this one.
    expect(
      trusts(role, token(environment, 'octo/suas/.github/workflows/other.yml@refs/heads/main')),
    ).toBe(false);
    expect(trusts(role, token(environment, DEPLOY_WORKFLOW.replace('main', 'attack')))).toBe(false);
    expect(trusts(role, { ...token(environment), job_workflow_ref: '' })).toBe(false);
    // Ordinary manual-job tokens do not contain the called-workflow claim.
    const { job_workflow_ref: _calledWorkflow, ...ordinaryToken } = token(environment);
    expect(trusts(role, ordinaryToken)).toBe(false);
    expect(trusts(role, { ...token(environment), aud: 'other' })).toBe(false);
    expect(
      trusts(role, { ...token(environment), sub: `repo:foreign/suas:environment:${environment}` }),
    ).toBe(false);
    expect(trusts(role, token(`${environment}-other`))).toBe(false);
  });

  // A prefix without exactly one owner/repo slash could widen or break the trusted subject.
  it('accepts only a repo:owner/name subject prefix', () => {
    const pattern = TEMPLATE.match(/SubjectPrefix:\n\s+Type: String\n\s+AllowedPattern: '(.+)'/);
    const allowed = new RegExp(pattern![1]!);
    for (const ok of ['repo:octo/suas', PARAMS.SubjectPrefix!]) expect(allowed.test(ok)).toBe(true);
    for (const bad of ['repo:foo', 'repo:a/b/c', 'repo:a:b', 'repo:a/b:c', 'repo:/b', 'repo:a/']) {
      expect(allowed.test(bad)).toBe(false);
    }
  });

  it('names environments the deploy workflow actually uses', () => {
    expect(WORKFLOW).toContain('environment: suas-synthetic-staging-plan');
    expect(WORKFLOW).toMatch(/environment:\n\s+name: suas-synthetic-staging\n/);
  });
});
