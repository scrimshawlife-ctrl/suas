/**
 * The VA verify function (VA_CONFIRMATION_FLOW W9 item 4, R9.2 option (b), released in 0.10.0):
 * built only with `-c vaSandbox=true`, outside the VPC, with no database setting, reading only its
 * own secret, and invoked only by the API. Offline, against the in-memory templates.
 */

import { App } from 'aws-cdk-lib';
import { beforeAll, describe, expect, it } from 'vitest';
import { VA_SECRET_READ_TIMEOUT_MS } from '../../src/aws/va-verify-lambda.js';
import { tryLoadConfig } from '../../src/config/index.js';
import { VA_VERIFY_INVOKE_TIMEOUT_MS } from '../../src/identity/va-confirmation-lambda-relay.js';
import { OUTBOUND_FETCH_TIMEOUT_MS } from '../../src/resilience/outbound-fetch.js';
import { createStagingApp } from '../lib/staging.js';
import { resolveForValidation, synthesize, type Synthesized } from './helpers.js';

type Resource = { Type: string; Properties?: Record<string, any> };
type Template = Synthesized['backend'];
const resourcesOf = (t: Template): Record<string, Resource> =>
  t.toJSON().Resources as Record<string, Resource>;
const parametersOf = (t: Template): Record<string, Resource> =>
  (t.toJSON().Parameters ?? {}) as Record<string, Resource>;
const ofType = (t: Template, type: string): Array<[string, Resource]> =>
  Object.entries(resourcesOf(t)).filter(([, r]) => r.Type === type);
const functionByHandler = (t: Template, handler: string): [string, Resource] | undefined =>
  ofType(t, 'AWS::Lambda::Function').find(([, r]) => r.Properties?.Handler === handler);
const roleOf = (t: Template, handler: string): string =>
  String(functionByHandler(t, handler)?.[1].Properties?.Role['Fn::GetAtt'][0]);
const policies = (t: Template) =>
  ofType(t, 'AWS::IAM::Policy').map(([, p]) => ({
    roles: (p.Properties?.Roles as Array<{ Ref: string }>).map((r) => r.Ref),
    statements: p.Properties?.PolicyDocument.Statement as Array<Record<string, any>>,
  }));

let off: Synthesized;
let on: Synthesized;
beforeAll(() => {
  off = synthesize();
  on = synthesize({ vaSandbox: 'true' });
});

describe('VA verify function', () => {
  it('is not built by default, and the API keeps VA confirmation disabled', () => {
    expect(functionByHandler(off.backend, 'va-verify.handler')).toBeUndefined();
    const [, api] = functionByHandler(off.backend, 'run.sh') ?? [];
    const variables = api?.Properties?.Environment.Variables as Record<string, unknown>;
    expect(Object.keys(variables).filter((k) => k.startsWith('SUAS_VA_CONFIRMATION'))).toEqual([]);
    expect(Object.keys(off.backend.toJSON().Outputs)).not.toContain('VaVerifySecretName');
  });

  // The deploy-time switch: only `vaSandbox=true` adds the construct's resources.
  it('adds its function, role, secret and log group only with vaSandbox=true', () => {
    const vaVerifyTypes = (t: Template) =>
      Object.entries(resourcesOf(t))
        .filter(([id]) => id.startsWith('VaVerify'))
        .map(([, r]) => r.Type);
    expect(vaVerifyTypes(off.backend)).toEqual([]);
    expect(vaVerifyTypes(on.backend)).toEqual(
      expect.arrayContaining([
        'AWS::IAM::Role',
        'AWS::Lambda::Function',
        'AWS::Logs::LogGroup',
        'AWS::SecretsManager::Secret',
      ]),
    );
  });

  it('runs outside the VPC, with no database setting, only its environment class and secret id', () => {
    const [, fn] = functionByHandler(on.backend, 'va-verify.handler') ?? [];
    expect(fn?.Properties?.VpcConfig).toBeUndefined();
    const variables = fn?.Properties?.Environment.Variables as Record<string, unknown>;
    expect(Object.keys(variables).sort()).toEqual(['SUAS_ENV', 'SUAS_VA_CONFIRMATION_SECRET_ID']);
    expect(variables.SUAS_ENV).toBe('STAGING');
    expect(JSON.stringify(variables.SUAS_VA_CONFIRMATION_SECRET_ID)).toContain('VaVerifyApiKey');
    expect(JSON.stringify(fn)).not.toMatch(/DATABASE_URL|ProxySg|DatabaseSg|LambdaSg|Session/);
    expect(Object.keys(on.backend.toJSON().Outputs)).toContain('VaVerifySecretName');
  });

  it('holds only the VA key in its secret, as a placeholder the operator replaces', () => {
    const secrets = ofType(on.backend, 'AWS::SecretsManager::Secret').filter(([id]) =>
      id.startsWith('VaVerifyApiKey'),
    );
    expect(secrets).toHaveLength(1);
    const generated = secrets[0]?.[1].Properties?.GenerateSecretString;
    expect(JSON.parse(generated.SecretStringTemplate)).toEqual({
      SUAS_VA_CONFIRMATION_API_KEY: '',
    });
  });

  it('lets only its role read its secret, and its role writes logs and reads that secret only', () => {
    const role = roleOf(on.backend, 'va-verify.handler');
    const readers = policies(on.backend).filter((p) =>
      p.statements.some((st) => JSON.stringify(st.Resource).includes('VaVerifyApiKey')),
    );
    expect(readers.map((p) => p.roles)).toEqual([[role]]);
    const own = policies(on.backend).filter((p) => p.roles.includes(role));
    expect(own).toHaveLength(1);
    for (const st of own[0]?.statements ?? []) {
      const actions = [st.Action].flat() as string[];
      expect(actions.every((a) => /^(secretsmanager|logs):/.test(a))).toBe(true);
      if (actions.some((a) => a.startsWith('secretsmanager:'))) {
        expect(JSON.stringify(st.Resource)).toContain('VaVerifyApiKey');
      }
    }
  });

  // Review of #326: a version that put-secret-value replaced stays unreadable with this role.
  it('reads only the current version of its secret, and the function asks for it by stage', () => {
    const role = roleOf(on.backend, 'va-verify.handler');
    const [own] = policies(on.backend).filter((p) => p.roles.includes(role));
    const reads = (own?.statements ?? []).filter((st) =>
      [st.Action].flat().some((a: string) => a.startsWith('secretsmanager:')),
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      Effect: 'Allow',
      Action: 'secretsmanager:GetSecretValue',
      Condition: { StringEquals: { 'secretsmanager:VersionStage': 'AWSCURRENT' } },
    });
    expect(JSON.stringify(reads[0]?.Resource)).toContain('VaVerifyApiKey');
  });

  // Review of #326: the secret ships with a placeholder; a refusal for want of a key shows here.
  it('alarms on any not_configured refusal in its log group, and only with vaSandbox=true', () => {
    const notConfigured = (t: Template) => ({
      filters: ofType(t, 'AWS::Logs::MetricFilter').filter(
        ([, r]) => r.Properties?.MetricTransformations?.[0]?.MetricName === 'VaVerifyNotConfigured',
      ),
      alarms: ofType(t, 'AWS::CloudWatch::Alarm').filter(
        ([, r]) => r.Properties?.MetricName === 'VaVerifyNotConfigured',
      ),
    });
    expect(notConfigured(off.backend)).toEqual({ filters: [], alarms: [] });

    const { filters, alarms } = notConfigured(on.backend);
    const [logGroupId] = ofType(on.backend, 'AWS::Logs::LogGroup')
      .map(([id]) => id)
      .filter((id) => id.startsWith('VaVerifyLogs'));
    expect(filters).toHaveLength(1);
    expect(filters[0]?.[1].Properties).toMatchObject({
      LogGroupName: { Ref: logGroupId },
      FilterPattern: '"va_verify_refused" "not_configured"',
      MetricTransformations: [
        { MetricNamespace: 'Suas/staging', MetricValue: '1', DefaultValue: 0 },
      ],
    });
    expect(alarms).toHaveLength(1);
    const alarm = alarms[0]?.[1].Properties;
    expect(alarm).toMatchObject({
      Namespace: 'Suas/staging',
      Statistic: 'Sum',
      Period: 300,
      EvaluationPeriods: 1,
      Threshold: 1,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });
    expect(alarm?.AlarmActions).toBeUndefined();
  });

  it('may be invoked by the API role only, through an identity policy scoped to its ARN', () => {
    const [fnId] = functionByHandler(on.backend, 'va-verify.handler') ?? [];
    const invokers = policies(on.backend).filter((p) =>
      p.statements.some(
        (st) =>
          [st.Action].flat().some((a: string) => a === '*' || /^lambda:(\*|Invoke)/.test(a)) &&
          [st.Resource].flat().some((r) => /VaVerify/.test(JSON.stringify(r))),
      ),
    );
    expect(invokers.map((p) => p.roles)).toEqual([[roleOf(on.backend, 'run.sh')]]);
    // The relay invokes the name CDK took from this construct, not a value set elsewhere.
    const [, api] = functionByHandler(on.backend, 'run.sh') ?? [];
    expect(api?.Properties?.Environment.Variables.SUAS_VA_CONFIRMATION_RELAY_FUNCTION).toEqual({
      Ref: fnId,
    });
    const arn = { 'Fn::GetAtt': [fnId, 'Arn'] };
    const grant = invokers[0]?.statements.find((st) =>
      JSON.stringify(st.Resource).includes('VaVerify'),
    );
    expect(grant).toMatchObject({
      Action: 'lambda:InvokeFunction',
      Resource: [arn, { 'Fn::Join': ['', [arn, ':*']] }],
    });
    expect(
      ofType(on.backend, 'AWS::Lambda::Permission').filter(([, r]) =>
        /VaVerify/.test(JSON.stringify(r)),
      ),
    ).toEqual([]);
    expect(ofType(on.backend, 'AWS::Lambda::Url')).toEqual([]);
  });

  it('gives every in-VPC function a configuration the application accepts, VA through the relay', () => {
    const resources = { ...resourcesOf(on.backend), ...parametersOf(on.backend) };
    const inVpc = ofType(on.backend, 'AWS::Lambda::Function').filter(
      ([, r]) => r.Properties?.VpcConfig !== undefined,
    );
    expect(inVpc).toHaveLength(3);
    for (const [name, fn] of inVpc) {
      const variables = fn.Properties?.Environment.Variables as Record<string, unknown>;
      expect(variables).not.toHaveProperty('SUAS_VA_CONFIRMATION_API_KEY');
      expect(variables).not.toHaveProperty('SUAS_VA_CONFIRMATION_BASE_URL');
      const env = Object.fromEntries(
        Object.entries(variables).map(([k, v]) => [k, resolveForValidation(v, resources)]),
      );
      const result = tryLoadConfig(env);
      expect(result.ok ? [] : result.issues, name).toEqual([]);
      if (!result.ok) continue;
      const api = fn.Properties?.Handler === 'run.sh';
      expect(result.config.vaConfirmation.mode).toBe(api ? 'sandbox' : 'disabled');
      expect(result.config.vaConfirmation.relayFunction !== undefined).toBe(api);
      expect(result.config.vaConfirmation.apiKey).toBeUndefined();
    }
  });

  // Each layer gives up after the one below it, so the verify function's own answer (or its
  // timeout) reaches the API before the API stops waiting. Its own budget is a secret read then VA.
  it('orders the timeouts: secret read + VA fetch < verify function < relay invoke < HTTP API < API function', () => {
    const seconds = (handler: string) =>
      Number(functionByHandler(on.backend, handler)?.[1].Properties?.Timeout) * 1000;
    const [[, integration] = []] = ofType(on.backend, 'AWS::ApiGatewayV2::Integration');
    const chain = [
      VA_SECRET_READ_TIMEOUT_MS + OUTBOUND_FETCH_TIMEOUT_MS,
      seconds('va-verify.handler'),
      VA_VERIFY_INVOKE_TIMEOUT_MS,
      Number(integration?.Properties?.TimeoutInMillis),
      seconds('run.sh'),
    ];
    chain.slice(1).forEach((later, i) => {
      expect(chain[i], `step ${String(i + 1)} of ${chain.join(' < ')}`).toBeLessThan(later);
    });
  });

  it('refuses a vaSandbox value other than true or false', () => {
    expect(() => createStagingApp(new App({ context: { vaSandbox: 'yes' } }))).toThrow(
      'Context "vaSandbox" must be true or false.',
    );
  });
});
