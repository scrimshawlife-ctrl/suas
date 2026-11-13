/**
 * STAGING provisioning: the web origin on the API allowlist (R11.3, D-038), the fixture
 * registry from one SSM parameter (R11.5, D-052), and the migrate function that seeds it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { synthesize, type Synthesized } from './helpers.js';

type Resource = { Type: string; Properties?: Record<string, any>; Default?: string };

let s: Synthesized;
beforeAll(() => {
  s = synthesize();
});

const resourcesOf = (template: Synthesized['backend']): Record<string, Resource> =>
  template.toJSON().Resources as Record<string, Resource>;

/** Environment variables of the function with this handler. */
function envOf(template: Synthesized['backend'], handler: string): Record<string, unknown> {
  const fn = Object.values(resourcesOf(template)).find(
    (r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.Handler === handler,
  );
  if (fn === undefined) throw new Error(`No function with handler ${handler}.`);
  return fn.Properties?.Environment.Variables as Record<string, unknown>;
}

const HANDLERS = ['run.sh', 'job-worker.handler', 'migrate.handler'] as const;

describe('R11.3 cross-origin allowlist', () => {
  it('lists the staging web origin on the API function only', () => {
    expect(envOf(s.backend, 'run.sh').SUAS_CORS_ALLOWED_ORIGINS).toBe(
      'https://staging.suasqrf.com',
    );
    expect(envOf(s.backend, 'job-worker.handler').SUAS_CORS_ALLOWED_ORIGINS).toBeUndefined();
    expect(envOf(s.backend, 'migrate.handler').SUAS_CORS_ALLOWED_ORIGINS).toBeUndefined();
  });

  it('follows the webHostname context', () => {
    const other = synthesize({ webHostname: 'web.staging.suasqrf.com' });
    expect(envOf(other.backend, 'run.sh').SUAS_CORS_ALLOWED_ORIGINS).toBe(
      'https://web.staging.suasqrf.com',
    );
  });
});

describe('R11.5 fixture registry', () => {
  it('passes one deploy-time SSM parameter to the API, job worker and migrate functions', () => {
    const parameters = (s.backend.toJSON().Parameters ?? {}) as Record<string, Resource>;
    for (const handler of HANDLERS) {
      const value = envOf(s.backend, handler).SUAS_STAGING_FIXTURE_REGISTRY as { Ref: string };
      const parameter = parameters[value.Ref];
      expect(parameter?.Type, handler).toBe('AWS::SSM::Parameter::Value<String>');
      expect(parameter?.Default, handler).toBe('/suas/staging/fixture-registry');
    }
  });

  it('grants no function an SSM action: the value is resolved at deploy, not read at run time', () => {
    const actions = Object.values(resourcesOf(s.backend))
      .filter((r) => r.Type === 'AWS::IAM::Policy')
      .flatMap((p) =>
        (p.Properties?.PolicyDocument.Statement as Array<{ Action: string | string[] }>).flatMap(
          (st) => [st.Action].flat(),
        ),
      );
    expect(actions.filter((action) => action.startsWith('ssm:'))).toEqual([]);
  });
});

describe('migrate function (runs migrations and the fixture seed)', () => {
  it('may only write its logs and manage its ENIs', () => {
    const resources = resourcesOf(s.backend);
    const fn = Object.values(resources).find(
      (r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.Handler === 'migrate.handler',
    );
    const roleId = (fn?.Properties?.Role as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'][0];
    const actions = Object.values(resources)
      .filter(
        (r) =>
          r.Type === 'AWS::IAM::Policy' &&
          (r.Properties?.Roles as Array<{ Ref: string }>).some((ref) => ref.Ref === roleId),
      )
      .flatMap((p) =>
        (p.Properties?.PolicyDocument.Statement as Array<{ Action: string | string[] }>).flatMap(
          (st) => [st.Action].flat(),
        ),
      );
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) expect(action).toMatch(/^(logs|ec2):/);
    expect(resources[roleId]?.Properties?.ManagedPolicyArns).toBeUndefined();
  });
});
