/**
 * The inference relay and its guardrail (R17.3/R17.5, contributor proposal, not released): built
 * only with `-c modelInference=bedrock`, outside the VPC, the one role with Bedrock, and invoked
 * only by the API. Offline, against the in-memory templates.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { tryLoadConfig } from '../../src/config/index.js';
import { INFERENCE_RELAY_INVOKE_TIMEOUT_MS } from '../../src/inference/lambda-relay-inference.js';
import { INFERENCE_PURPOSE_LIMITS } from '../../src/inference/model-inference.js';
import {
  GUARDRAIL_BLOCKED_MESSAGE,
  GUARDRAIL_CONTENT_FILTERS,
  guardrailFingerprint,
} from '../lib/backend-stack.js';
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
const apiVariables = (t: Template): Record<string, unknown> =>
  functionByHandler(t, 'run.sh')?.[1].Properties?.Environment.Variables;

/** Renders each `Fn::Join` of literals and pseudo-parameter Refs as one `${AWS::X}` string. */
const renderArns = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(renderArns);
  if (typeof value !== 'object' || value === null) return value;
  const node = value as Record<string, unknown>;
  if ('Fn::Join' in node) {
    const [sep, parts] = node['Fn::Join'] as [string, unknown[]];
    const rendered = parts.map((part) => {
      const ref = (part as { Ref?: string } | null)?.Ref;
      return typeof part === 'string' ? part : ref?.startsWith('AWS::') ? `\${${ref}}` : part;
    });
    if (rendered.every((part) => typeof part === 'string')) return rendered.join(sep);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, renderArns(v)]));
};

const MODEL_ID = 'qwen.qwen3-32b-v1:0';
const INFERENCE_KEYS = [
  'SUAS_BEDROCK_GUARDRAIL_ID',
  'SUAS_BEDROCK_GUARDRAIL_VERSION',
  'SUAS_BEDROCK_MODEL_ID',
  'SUAS_MODEL_INFERENCE_RELAY_FUNCTION',
];

let off: Synthesized;
let on: Synthesized;
beforeAll(() => {
  off = synthesize();
  on = synthesize({ modelInference: 'bedrock', bedrockModelId: MODEL_ID });
});

describe('inference relay', () => {
  it('is not built by default: no relay, no guardrail, and the API keeps inference disabled', () => {
    expect(functionByHandler(off.backend, 'inference-relay.handler')).toBeUndefined();
    expect(
      Object.values(resourcesOf(off.backend)).filter((r) => r.Type.startsWith('AWS::Bedrock::')),
    ).toEqual([]);
    const variables = apiVariables(off.backend);
    expect(variables.SUAS_MODEL_INFERENCE_MODE).toBe('disabled');
    for (const key of INFERENCE_KEYS) expect(variables).not.toHaveProperty(key);
  });

  it('runs outside the VPC on Node 22 arm64, 512 MB, 27 s, with only its five settings', () => {
    const [, fn] = functionByHandler(on.backend, 'inference-relay.handler') ?? [];
    const props = fn?.Properties;
    expect(props?.VpcConfig).toBeUndefined();
    expect(props?.ReservedConcurrentExecutions).toBeUndefined();
    expect(props).toMatchObject({
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      MemorySize: 512,
      Timeout: 27,
    });
    expect(props?.Environment.Variables).toEqual({
      SUAS_ENV: 'STAGING',
      SUAS_AWS_REGION: 'us-west-2',
      SUAS_BEDROCK_MODEL_ID: MODEL_ID,
      SUAS_BEDROCK_GUARDRAIL_ID: { 'Fn::GetAtt': ['InferenceGuardrail', 'GuardrailId'] },
      SUAS_BEDROCK_GUARDRAIL_VERSION: { 'Fn::GetAtt': ['InferenceGuardrailVersion', 'Version'] },
    });
    expect(JSON.stringify(fn)).not.toMatch(/DATABASE_URL|DatabaseSg|LambdaSg|Session|secret/i);
    const [logGroupId] = ofType(on.backend, 'AWS::Logs::LogGroup')
      .map(([id]) => id)
      .filter((id) => id.startsWith('InferenceRelayLogs'));
    expect(props?.LoggingConfig).toEqual({ LogGroup: { Ref: logGroupId } });
    expect(resourcesOf(on.backend)[String(logGroupId)]?.Properties?.RetentionInDays).toBe(30);
  });

  // R17.5 (proposal): harmful content on both sides, prompt attacks on input, no PII policy.
  it('creates exactly the proposed guardrail and one numbered version of it', () => {
    const guardrails = ofType(on.backend, 'AWS::Bedrock::Guardrail');
    expect(guardrails.map(([id]) => id)).toEqual(['InferenceGuardrail']);
    const blocked = "This message can't be processed. Please use the request form.";
    const filter = (Type: string) => ({ Type, InputStrength: 'MEDIUM', OutputStrength: 'MEDIUM' });
    expect(guardrails[0]?.[1].Properties).toEqual({
      Name: 'suas-staging-inference',
      Description: 'SUAS STAGING intake and catalog extraction (R17.5, contributor proposal).',
      BlockedInputMessaging: blocked,
      BlockedOutputsMessaging: blocked,
      ContentPolicyConfig: {
        FiltersConfig: [
          filter('HATE'),
          filter('INSULTS'),
          filter('SEXUAL'),
          filter('VIOLENCE'),
          filter('MISCONDUCT'),
          { Type: 'PROMPT_ATTACK', InputStrength: 'HIGH', OutputStrength: 'NONE' },
        ],
      },
    });

    const versions = ofType(on.backend, 'AWS::Bedrock::GuardrailVersion');
    expect(versions).toHaveLength(1);
    expect(versions[0]?.[1].Properties).toEqual({
      GuardrailIdentifier: { 'Fn::GetAtt': ['InferenceGuardrail', 'GuardrailId'] },
      Description: expect.stringMatching(/^Config [0-9a-f]{16}$/),
    });
  });

  // R17.x (contributor's call, D-064): the same guardrail config written with its keys in another
  // order must keep its version, so the fingerprint hashes canonical JSON.
  const reversedKeys = <T extends object>(value: T): T =>
    Object.fromEntries(Object.entries(value).reverse()) as T;
  const inOrderProps = {
    name: 'suas-staging-inference',
    description: 'SUAS STAGING intake and catalog extraction (R17.5, contributor proposal).',
    blockedInputMessaging: GUARDRAIL_BLOCKED_MESSAGE,
    blockedOutputsMessaging: GUARDRAIL_BLOCKED_MESSAGE,
    contentPolicyConfig: { filtersConfig: [...GUARDRAIL_CONTENT_FILTERS] },
  };
  const reorderedProps = {
    ...reversedKeys(inOrderProps),
    contentPolicyConfig: { filtersConfig: GUARDRAIL_CONTENT_FILTERS.map(reversedKeys) },
  };

  it('fingerprints a guardrail config the same whatever its key order', () => {
    expect(guardrailFingerprint(reorderedProps)).toBe(guardrailFingerprint(inOrderProps));
  });

  it('names the version by the fingerprint of the guardrail config, not its key order', () => {
    const [, version] = ofType(on.backend, 'AWS::Bedrock::GuardrailVersion')[0] ?? [];
    expect(version?.Properties?.Description).toBe(`Config ${guardrailFingerprint(reorderedProps)}`);
  });

  it('gives its role logs, InvokeModel on the one model in its region, and the guardrail only', () => {
    const role = roleOf(on.backend, 'inference-relay.handler');
    const own = policies(on.backend).filter((p) => p.roles.includes(role));
    expect(own).toHaveLength(1);
    const [logGroupId] = ofType(on.backend, 'AWS::Logs::LogGroup')
      .map(([id]) => id)
      .filter((id) => id.startsWith('InferenceRelayLogs'));
    expect(own[0]?.statements.map(renderArns)).toEqual([
      {
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': [logGroupId, 'Arn'] },
      },
      {
        Action: 'bedrock:InvokeModel',
        Effect: 'Allow',
        Resource: `arn:\${AWS::Partition}:bedrock:us-west-2::foundation-model/${MODEL_ID}`,
      },
      {
        Action: 'bedrock:ApplyGuardrail',
        Effect: 'Allow',
        Resource: { 'Fn::GetAtt': ['InferenceGuardrail', 'GuardrailArn'] },
      },
    ]);
    const [, roleResource] = ofType(on.backend, 'AWS::IAM::Role').find(([id]) => id === role) ?? [];
    expect(roleResource?.Properties?.ManagedPolicyArns).toBeUndefined();
  });

  // R17.x (contributor's call, D-064): on-demand invocation, so one regional model ARN and no
  // inference-profile ARN or condition anywhere in the stack.
  it('grants InvokeModel on exactly one foundation-model ARN in the stack region, unconditioned', () => {
    const invokes = policies(on.backend)
      .flatMap((p) => p.statements)
      .filter((st) => [st.Action].flat().some((a: string) => /^bedrock:(\*|Invoke)/.test(a)));
    expect(invokes).toHaveLength(1);
    expect([renderArns(invokes[0]?.Resource)].flat()).toEqual([
      `arn:\${AWS::Partition}:bedrock:us-west-2::foundation-model/${MODEL_ID}`,
    ]);
    expect(invokes[0]?.Condition).toBeUndefined();
    expect(JSON.stringify(on.backend.toJSON())).not.toMatch(
      /inference-profile|InferenceProfileArn/,
    );
  });

  it('may be invoked by the API role only, through an identity policy scoped to its ARN', () => {
    const [fnId] = functionByHandler(on.backend, 'inference-relay.handler') ?? [];
    const invokers = policies(on.backend).filter((p) =>
      p.statements.some(
        (st) =>
          [st.Action].flat().some((a: string) => a === '*' || /^lambda:(\*|Invoke)/.test(a)) &&
          [st.Resource].flat().some((r) => JSON.stringify(r).includes(String(fnId))),
      ),
    );
    expect(invokers.map((p) => p.roles)).toEqual([[roleOf(on.backend, 'run.sh')]]);
    const arn = { 'Fn::GetAtt': [fnId, 'Arn'] };
    const grant = invokers[0]?.statements.find((st) =>
      JSON.stringify(st.Resource).includes(String(fnId)),
    );
    expect(grant?.Action).toBe('lambda:InvokeFunction');
    expect(grant?.Resource).toEqual(
      expect.arrayContaining([arn, { 'Fn::Join': ['', [arn, ':*']] }]),
    );
    expect(
      ofType(on.backend, 'AWS::Lambda::Permission').filter(([, r]) =>
        JSON.stringify(r).includes(String(fnId)),
      ),
    ).toEqual([]);
    expect(ofType(on.backend, 'AWS::Lambda::Url')).toEqual([]);
  });

  it('gives the API a configuration the application accepts, with inference through the relay', () => {
    const [fnId] = functionByHandler(on.backend, 'inference-relay.handler') ?? [];
    const variables = apiVariables(on.backend);
    expect(variables).toMatchObject({
      SUAS_MODEL_INFERENCE_MODE: 'bedrock',
      SUAS_BEDROCK_MODEL_ID: MODEL_ID,
      SUAS_BEDROCK_GUARDRAIL_ID: { 'Fn::GetAtt': ['InferenceGuardrail', 'GuardrailId'] },
      SUAS_BEDROCK_GUARDRAIL_VERSION: { 'Fn::GetAtt': ['InferenceGuardrailVersion', 'Version'] },
      SUAS_MODEL_INFERENCE_RELAY_FUNCTION: { Ref: fnId },
    });
    const resources = { ...resourcesOf(on.backend), ...parametersOf(on.backend) };
    const env = Object.fromEntries(
      Object.entries(variables).map(([k, v]) => [k, resolveForValidation(v, resources)]),
    );
    const result = tryLoadConfig(env);
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (result.ok) {
      expect(result.config.modelInference.mode).toBe('bedrock');
      expect(result.config.modelInference.relayFunction).toBeDefined();
    }
    // The worker and migrate function never call a model.
    for (const handler of ['job-worker.handler', 'migrate.handler']) {
      const other = functionByHandler(on.backend, handler)?.[1].Properties?.Environment.Variables;
      expect(other.SUAS_MODEL_INFERENCE_MODE, handler).not.toBe('bedrock');
      for (const key of INFERENCE_KEYS) expect(other, handler).not.toHaveProperty(key);
    }
  });

  // Review 2026-11-24 (#367): relay failures and guardrail or content-filter refusals show up as
  // alarms. Terms, not a JSON selector: the Node runtime prefixes the relay's log lines.
  it('alarms on relay failures and on refused turns, on the relay log group only', () => {
    const relayAlarms = (t: Template) =>
      ofType(t, 'AWS::Logs::MetricFilter').filter(([, r]) =>
        String(r.Properties?.MetricTransformations?.[0]?.MetricName).startsWith('InferenceRelay'),
      );
    expect(relayAlarms(off.backend)).toEqual([]);

    const filters: Record<string, Record<string, any> | undefined> = Object.fromEntries(
      relayAlarms(on.backend).map(([, r]) => [
        r.Properties?.MetricTransformations[0].MetricName,
        r.Properties,
      ]),
    );
    expect(Object.keys(filters).sort()).toEqual([
      'InferenceRelayFailures',
      'InferenceRelayRefusals',
    ]);
    expect(filters.InferenceRelayFailures?.FilterPattern).toBe(
      '?"inference_relay_refused" ?"unavailable" ?"timeout" ?"invalid"',
    );
    expect(filters.InferenceRelayRefusals?.FilterPattern).toBe('"model_inference" "refused"');
    const relayLogGroup = ofType(on.backend, 'AWS::Logs::LogGroup').find(([id]) =>
      id.startsWith('InferenceRelayLogs'),
    )?.[0];
    for (const filter of Object.values(filters)) {
      expect(filter?.LogGroupName).toEqual({ Ref: relayLogGroup });
    }
    const alarms = ofType(on.backend, 'AWS::CloudWatch::Alarm').filter(([, r]) =>
      String(r.Properties?.MetricName).startsWith('InferenceRelay'),
    );
    expect(alarms).toHaveLength(2);
    for (const [, alarm] of alarms) {
      expect(alarm.Properties).toMatchObject({
        Threshold: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      });
    }
  });

  it('adds no Bedrock VPC endpoint: the VPC still reaches only S3 and Lambda', () => {
    const services = ofType(on.backend, 'AWS::EC2::VPCEndpoint').map(([, r]) =>
      JSON.stringify(r.Properties?.ServiceName),
    );
    expect(services).toHaveLength(2);
    expect(services.join(' ')).not.toMatch(/bedrock/);
  });

  // Each layer gives up after the one below it, so the relay's answer (or its own timeout)
  // reaches the API before the API stops waiting, and the API answers before the HTTP API does.
  it('orders the timeouts: longest model call < relay < relay invoke abort < HTTP API < API function', () => {
    const seconds = (handler: string) =>
      Number(functionByHandler(on.backend, handler)?.[1].Properties?.Timeout) * 1000;
    const [[, integration] = []] = ofType(on.backend, 'AWS::ApiGatewayV2::Integration');
    const longestCall = Math.max(
      ...Object.values(INFERENCE_PURPOSE_LIMITS).map((limit) => limit.callTimeoutCapMs),
    );
    const chain = [
      longestCall,
      seconds('inference-relay.handler'),
      INFERENCE_RELAY_INVOKE_TIMEOUT_MS,
      Number(integration?.Properties?.TimeoutInMillis),
      seconds('run.sh'),
    ];
    chain.slice(1).forEach((later, i) => {
      expect(chain[i], `step ${String(i + 1)} of ${chain.join(' < ')}`).toBeLessThan(later);
    });
  });
});
