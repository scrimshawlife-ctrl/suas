/**
 * The deploy workflow's maintenance contract (`-c deploymentPipeline=true`): every mode's
 * admission and schedule state, the migrator left alone, and the legacy template unchanged.
 */

import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EXPECTED_SCHEMA_VERSION } from '../../src/db/schema-version.js';
import { repoRoot } from '../lib/lambda-code.js';
import { synthesize } from './helpers.js';

// Inline code and a synthetic web/dist keep this test independent of bundling and local builds.
vi.mock('../lib/lambda-code.js', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Code } = await import('aws-cdk-lib/aws-lambda');
  const root = mkdtempSync(join(tmpdir(), 'suas-deployment-mode-'));
  mkdirSync(join(root, 'web/dist/assets'), { recursive: true });
  writeFileSync(join(root, 'web/dist/index.html'), '<script src="/assets/app-hash.js"></script>');
  writeFileSync(join(root, 'web/dist/assets/app-hash.js'), 'console.log("synthetic");');
  return {
    repoRoot: root,
    RDS_CA_BUNDLE_FILE: 'rds-global-bundle.crt',
    suasLambdaCode: () => Code.fromInline('export const handler = async () => ({});'),
  };
});

afterAll(() => rmSync(repoRoot, { recursive: true, force: true }));

type Resource = { Type: string; Properties: Record<string, any>; DependsOn?: string[] };
type Template = {
  Parameters: Record<string, any>;
  Conditions: Record<string, any>;
  Resources: Record<string, Resource>;
  Outputs: Record<string, any>;
};

const pipeline = synthesize({ deploymentPipeline: 'true' });
const backend = pipeline.backend.toJSON() as Template;
const legacy = synthesize();
const NO_VALUE = Symbol('AWS::NoValue');

const resources = (template: Template, type: string): Array<[string, Resource]> =>
  Object.entries(template.Resources).filter(([, r]) => r.Type === type);
const only = (template: Template, type: string): [string, Resource] => {
  const found = resources(template, type);
  if (found.length !== 1) throw new Error(`Expected one ${type}, found ${found.length}`);
  return found[0]!;
};
const fn = (template: Template, handler: string): [string, Resource] => {
  const found = resources(template, 'AWS::Lambda::Function').find(
    ([, r]) => r.Properties.Handler === handler,
  );
  if (!found) throw new Error(`Missing function ${handler}`);
  return found;
};

// Evaluates the emitted intrinsic functions so each mode is checked as CloudFormation sees it.
function evaluate(value: any, mode: string): any {
  if (typeof value !== 'object' || value === null) return value;
  if (value.Ref === 'AWS::NoValue') return NO_VALUE;
  if (value.Ref === 'DeploymentMode') return mode;
  if ('Condition' in value) return evaluate(backend.Conditions[value.Condition], mode);
  if ('Fn::Equals' in value) {
    const [a, b] = value['Fn::Equals'];
    return evaluate(a, mode) === evaluate(b, mode);
  }
  if ('Fn::Or' in value) return value['Fn::Or'].some((v: any) => evaluate(v, mode));
  if ('Fn::If' in value) {
    const [condition, yes, no] = value['Fn::If'];
    return evaluate(evaluate(backend.Conditions[condition], mode) ? yes : no, mode);
  }
  throw new Error(`Unexpected expression ${JSON.stringify(value)}`);
}

describe('deploy workflow maintenance modes', () => {
  it('defaults to maintenance and accepts only the four modes', () => {
    expect(backend.Parameters.DeploymentMode).toMatchObject({
      Type: 'String',
      Default: 'maintenance',
      AllowedValues: ['maintenance', 'api', 'worker', 'live'],
    });
  });

  // 0 blocks new invocations; NoValue removes the reservation, so no budget is invented.
  it.each([
    ['maintenance', 0, 0, 'DISABLED'],
    ['api', NO_VALUE, 0, 'DISABLED'],
    ['worker', NO_VALUE, NO_VALUE, 'DISABLED'],
    ['live', NO_VALUE, NO_VALUE, 'ENABLED'],
  ])('%s: api %s, worker %s, schedule %s', (mode, api, worker, schedule) => {
    const reserved = (handler: string) =>
      evaluate(fn(backend, handler)[1].Properties.ReservedConcurrentExecutions, mode);
    expect(reserved('run.sh')).toBe(api);
    expect(reserved('job-worker.handler')).toBe(worker);
    const [, scheduleResource] = only(backend, 'AWS::Scheduler::Schedule');
    expect(evaluate(scheduleResource.Properties.State, mode)).toBe(schedule);
    expect(fn(backend, 'migrate.handler')[1].Properties).not.toHaveProperty(
      'ReservedConcurrentExecutions',
    );
  });

  it('outputs the physical names the workflow invokes', () => {
    for (const [output, handler] of [
      ['ApiFunctionName', 'run.sh'],
      ['JobWorkerFunctionName', 'job-worker.handler'],
      ['MigrateFunctionName', 'migrate.handler'],
    ] as const) {
      expect(backend.Outputs[output].Value).toEqual({ Ref: fn(backend, handler)[0] });
    }
    const [dbId] = only(backend, 'AWS::RDS::DBInstance');
    expect(backend.Outputs.ExpectedSchemaVersion.Value).toBe(String(EXPECTED_SCHEMA_VERSION));
    expect(backend.Outputs.DatabaseIdentifier.Value).toEqual({ Ref: dbId });
  });

  it('changes nothing else in the backend', () => {
    const stripped = structuredClone(backend.Resources);
    for (const resource of Object.values(stripped)) {
      delete resource.Properties.ReservedConcurrentExecutions;
      if (resource.Type === 'AWS::Scheduler::Schedule') resource.Properties.State = 'ENABLED';
    }
    expect(stripped).toEqual((legacy.backend.toJSON() as Template).Resources);
  });

  it('stays off unless the context is exactly true', () => {
    for (const template of [legacy.backend, synthesize({ deploymentPipeline: 'false' }).backend]) {
      const json = template.toJSON() as Template;
      expect(json.Parameters).not.toHaveProperty('DeploymentMode');
      expect(fn(json, 'run.sh')[1].Properties).not.toHaveProperty('ReservedConcurrentExecutions');
      expect(resources(json, 'AWS::Scheduler::Schedule')[0]![1].Properties.State).toBe('ENABLED');
    }
  });
});

describe('deploy workflow web publication', () => {
  it('uploads immutable assets before a revalidating index and never prunes', () => {
    const web = pipeline.web.toJSON() as Template;
    const deployments = resources(web, 'Custom::CDKBucketDeployment');
    expect(deployments).toHaveLength(2);
    const assets = deployments.find(([id]) => id.startsWith('SiteAssets'))!;
    const index = deployments.find(([id]) => id.startsWith('SiteFiles'))!;
    for (const [, d] of deployments) expect(d.Properties.Prune).toBe(false);
    expect(assets[1].Properties).toMatchObject({ Include: ['assets/*'], Exclude: ['*'] });
    expect(index[1].Properties.Exclude).toEqual(['assets/*']);
    expect(assets[1].Properties.SystemMetadata['cache-control']).toContain('immutable');
    expect(index[1].Properties.SystemMetadata['cache-control']).toContain('no-cache');
    expect(index[1].DependsOn).toContain(assets[0]);
    const [policyId, policy] = only(web, 'AWS::CloudFront::CachePolicy');
    expect(policy.Properties.CachePolicyConfig).toMatchObject({ MinTTL: 0, DefaultTTL: 0 });
    const [, distribution] = only(web, 'AWS::CloudFront::Distribution');
    expect(distribution.Properties.DistributionConfig.DefaultCacheBehavior.CachePolicyId).toEqual({
      Ref: policyId,
    });
  });

  it('keeps the single pruning upload without the context', () => {
    const previous = resources(legacy.web.toJSON() as Template, 'Custom::CDKBucketDeployment');
    expect(previous).toHaveLength(1);
    expect(previous[0]![1].Properties.Prune).toBe(true);
  });
});
