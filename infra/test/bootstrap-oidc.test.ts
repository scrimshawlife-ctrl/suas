import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The GitHub OIDC trust policies in infra/bootstrap/github-oidc.yaml, evaluated against token
// claims. Read as text like the workflow tests: each role's StringEquals map, with !Sub resolved.
const TEMPLATE = readFileSync(new URL('../bootstrap/github-oidc.yaml', import.meta.url), 'utf8');
const WORKFLOW = readFileSync(
  new URL('../../.github/workflows/staging-deploy.yml', import.meta.url),
  'utf8',
);
const PARAMS: Record<string, string> = {
  SubjectPrefix: 'repo:octo@1/suas@2',
  WorkflowRepository: 'octo/suas',
};
const DEPLOY_WORKFLOW = 'octo/suas/.github/workflows/staging-deploy.yml@refs/heads/main';

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
  it.each([
    ['DeployRole', 'suas-synthetic-staging'],
    ['PlanRole', 'suas-synthetic-staging-plan'],
  ] as const)('%s trusts only staging-deploy.yml on main in %s', (role, environment) => {
    expect(trusts(role, token(environment))).toBe(true);
    // Any other workflow file that names the environment, or a branch copy of this one.
    expect(
      trusts(role, token(environment, 'octo/suas/.github/workflows/other.yml@refs/heads/main')),
    ).toBe(false);
    expect(trusts(role, token(environment, DEPLOY_WORKFLOW.replace('main', 'attack')))).toBe(false);
    expect(trusts(role, { ...token(environment), job_workflow_ref: '' })).toBe(false);
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
