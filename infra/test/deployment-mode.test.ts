/**
 * The deploy workflow's maintenance contract (`-c deploymentPipeline=true`): every mode's
 * admission and schedule state, the migrator left alone, and the legacy template unchanged.
 */

import { rmSync } from 'node:fs';
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Template as Assertions } from 'aws-cdk-lib/assertions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EXPECTED_SCHEMA_VERSION } from '../../src/db/schema-version.js';
import { applyDeploymentMode } from '../lib/deployment-mode.js';
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
const legacyBackend = legacy.backend.toJSON() as Template;
const NO_VALUE = Symbol('AWS::NoValue');
// The function's own reservation outside the deploy workflow, absent or a fixed cap.
const OWN_CAP = Symbol('own cap');
// An absent property reads as AWS::NoValue: no reservation.
const ABSENT = { Ref: 'AWS::NoValue' };

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
function evaluate(value: any, mode: string, template: Template = backend): any {
  const ev = (v: any) => evaluate(v, mode, template);
  if (typeof value !== 'object' || value === null) return value;
  if (value.Ref === 'AWS::NoValue') return NO_VALUE;
  if (value.Ref === 'DeploymentMode') return mode;
  if ('Condition' in value) return ev(template.Conditions[value.Condition]);
  if ('Fn::Equals' in value) {
    const [a, b] = value['Fn::Equals'];
    return ev(a) === ev(b);
  }
  if ('Fn::Or' in value) return value['Fn::Or'].some(ev);
  if ('Fn::If' in value) {
    const [condition, yes, no] = value['Fn::If'];
    if (!(condition in template.Conditions)) throw new Error(`Undefined condition ${condition}`);
    return ev(ev(template.Conditions[condition]) ? yes : no);
  }
  throw new Error(`Unexpected expression ${JSON.stringify(value)}`);
}

// Every condition name an Fn::If anywhere in the template refers to.
const conditionRefs = (value: any): string[] =>
  typeof value !== 'object' || value === null
    ? []
    : [
        ...('Fn::If' in value ? [value['Fn::If'][0] as string] : []),
        ...Object.values(value).flatMap(conditionRefs),
      ];

const ownCap = (handler: string) =>
  fn(legacyBackend, handler)[1].Properties.ReservedConcurrentExecutions ?? NO_VALUE;

describe('deploy workflow maintenance modes', () => {
  it('defaults to maintenance and accepts only the four modes', () => {
    expect(backend.Parameters.DeploymentMode).toMatchObject({
      Type: 'String',
      Default: 'maintenance',
      AllowedValues: ['maintenance', 'api', 'worker', 'live'],
    });
  });

  // 0 blocks new invocations; an unblocked function keeps its own reservation (none, or a cap).
  it.each([
    ['maintenance', 0, 0, 'DISABLED'],
    ['api', OWN_CAP, 0, 'DISABLED'],
    ['worker', OWN_CAP, OWN_CAP, 'DISABLED'],
    ['live', OWN_CAP, OWN_CAP, 'ENABLED'],
  ])('%s: api %s, worker %s, schedule %s', (mode, api, worker, schedule) => {
    const reserved = (handler: string) =>
      evaluate(fn(backend, handler)[1].Properties.ReservedConcurrentExecutions ?? ABSENT, mode);
    const expected = (value: number | symbol, handler: string) =>
      value === OWN_CAP ? ownCap(handler) : value;
    expect(reserved('run.sh')).toBe(expected(api, 'run.sh'));
    expect(reserved('job-worker.handler')).toBe(expected(worker, 'job-worker.handler'));
    const [, scheduleResource] = only(backend, 'AWS::Scheduler::Schedule');
    expect(evaluate(scheduleResource.Properties.State, mode)).toBe(schedule);
    expect(reserved('migrate.handler')).toBe(ownCap('migrate.handler'));
  });

  // CloudFormation resolves Fn::If by condition logical ID, so each must name a defined one.
  it('points every Fn::If at a condition the template defines', () => {
    const refs = conditionRefs(backend.Resources);
    expect([...new Set(refs)].sort()).toEqual(['ApiBlocked', 'LiveMode', 'WorkerBlocked']);
    expect(Object.keys(backend.Conditions).sort()).toEqual([
      'ApiBlocked',
      'LiveMode',
      'WorkerBlocked',
    ]);
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
    const strip = (template: Template) => {
      const stripped = structuredClone(template.Resources);
      for (const resource of Object.values(stripped)) {
        delete resource.Properties.ReservedConcurrentExecutions;
        if (resource.Type === 'AWS::Scheduler::Schedule') resource.Properties.State = 'ENABLED';
      }
      return stripped;
    };
    expect(strip(backend)).toEqual(strip(legacyBackend));
  });

  it('stays off unless the context is exactly true', () => {
    for (const template of [legacy.backend, synthesize({ deploymentPipeline: 'false' }).backend]) {
      const json = template.toJSON() as Template;
      expect(json.Parameters).not.toHaveProperty('DeploymentMode');
      const reserved = fn(json, 'run.sh')[1].Properties.ReservedConcurrentExecutions;
      expect(typeof reserved).not.toBe('object');
      expect(resources(json, 'AWS::Scheduler::Schedule')[0]![1].Properties.State).toBe('ENABLED');
    }
  });
});

// A minimal stack, independent of the staging stacks, so a fixed cap is covered either way.
describe('deployment mode on capped functions', () => {
  const stack = new Stack(new App(), 'Capped');
  const handlerFn = (id: string, reservedConcurrentExecutions?: number) =>
    new lambda.Function(stack, id, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: `${id}.handler`,
      code: lambda.Code.fromInline('export const handler = async () => ({});'),
      ...(reservedConcurrentExecutions !== undefined ? { reservedConcurrentExecutions } : {}),
    });
  const api = handlerFn('api', 7);
  const worker = handlerFn('worker');
  applyDeploymentMode(stack, {
    api,
    worker,
    schedule: new scheduler.Schedule(stack, 'Schedule', {
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
      target: new schedulerTargets.LambdaInvoke(worker, {}),
    }),
    databaseIdentifier: 'db',
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
  });
  const template = Assertions.fromStack(stack).toJSON() as Template;

  it.each([
    ['maintenance', 0, 0],
    ['api', 7, 0],
    ['worker', 7, NO_VALUE],
    ['live', 7, NO_VALUE],
  ])('%s: capped api %s, uncapped worker %s', (mode, apiReserved, workerReserved) => {
    const reserved = (handler: string) =>
      evaluate(
        fn(template, handler)[1].Properties.ReservedConcurrentExecutions ?? ABSENT,
        mode,
        template,
      );
    expect(reserved('api.handler')).toBe(apiReserved);
    expect(reserved('worker.handler')).toBe(workerReserved);
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
