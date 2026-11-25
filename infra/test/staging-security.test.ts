import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { describe, expect, it } from 'vitest';
import { synthesize } from './helpers.js';

const file = new URL('../bootstrap/cfn-execution-policy.yaml', import.meta.url).pathname;
const DEFAULTS = { StagingRegion: 'us-west-2', ModelInference: 'disabled' };
// R14.x region-restricted layout (suas #360) with R17 Bedrock; contributor proposals, not released.
const EAST2_BEDROCK = { StagingRegion: 'us-east-2', ModelInference: 'bedrock' };

/** Each bootstrap policy's statements for these parameters, with `Fn::If` statements resolved. */
function loadPolicies(parameters: Record<string, string>) {
  const stack = new Stack(new App(), 'PolicyTest');
  new CfnInclude(stack, 'BootstrapPolicies', {
    templateFile: file,
    parameters: {
      StagingApiHostname: 'api.staging.example.org',
      StagingWebHostname: 'staging.example.org',
      ...parameters,
    },
  });
  const on: Record<string, boolean> = { BedrockInference: parameters.ModelInference === 'bedrock' };
  const resolve = (s: any) => (s['Fn::If'] ? s['Fn::If'][on[s['Fn::If'][0]] ? 1 : 2] : s);
  const byName: Record<string, any[]> = Object.fromEntries(
    Object.values<any>(Template.fromStack(stack).toJSON().Resources).map((p) => [
      p.Properties.ManagedPolicyName,
      p.Properties.PolicyDocument.Statement.map(resolve).filter(
        (s: any) => s.Ref !== 'AWS::NoValue',
      ),
    ]),
  );
  return { byName, statements: Object.values(byName).flat() };
}

const { statements } = loadPolicies(DEFAULTS);
const actions = (s: { Action: string | string[] }): string[] => [s.Action].flat();

describe('staging privilege boundary', () => {
  it('allows CloudFront creation without widening existing-resource actions', () => {
    const grants = statements.filter(
      (s) => s.Effect === 'Allow' && actions(s).includes('cloudfront:CreateDistribution'),
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].Resource).toBe('*');
    expect(actions(grants[0]).sort()).toEqual([
      'cloudfront:CreateCachePolicy',
      'cloudfront:CreateDistribution',
      'cloudfront:CreateOriginAccessControl',
    ]);
    expect(statements.flatMap(actions)).not.toContain('cloudfront:CreateDistributionWithTags');
    for (const action of [
      'cloudfront:UpdateDistribution',
      'cloudfront:DeleteDistribution',
      'cloudfront:TagResource',
    ]) {
      const scoped = statements.filter((s) => s.Effect === 'Allow' && actions(s).includes(action));
      expect(scoped.length).toBeGreaterThan(0);
      for (const grant of scoped) expect(grant.Resource).not.toBe('*');
    }
  });
  it('bounds every certificate-request path by exact domains, DNS, region and public issuance', () => {
    const grants = statements.filter(
      (s) => s.Effect === 'Allow' && actions(s).includes('acm:RequestCertificate'),
    );
    expect(grants).toHaveLength(1);
    const grant = grants[0];
    expect(grant.Resource).toBe('*');
    expect(actions(grant)).toEqual(['acm:RequestCertificate']);
    expect(grant.Condition).toEqual({
      StringEquals: {
        'aws:RequestedRegion': ['us-west-2', 'us-east-1'],
        'acm:ValidationMethod': 'DNS',
      },
      'ForAllValues:StringEquals': {
        'acm:DomainNames': ['api.staging.example.org', 'staging.example.org'],
      },
      Null: { 'acm:DomainNames': 'false', 'acm:CertificateAuthority': 'true' },
    });
    // Evaluate these supported condition operators against representative request contexts.
    const accepts = (context: Record<string, string | string[]>) =>
      Object.entries(grant.Condition.StringEquals).every(([key, values]) =>
        [values].flat().includes(context[key]),
      ) &&
      Object.entries(grant.Condition.Null).every(
        ([key, absent]) => (context[key] === undefined) === (absent === 'true'),
      ) &&
      Object.entries(grant.Condition['ForAllValues:StringEquals']).every(([key, values]) =>
        [context[key] ?? []].flat().every((value) => [values].flat().includes(value)),
      );
    const request = {
      'aws:RequestedRegion': 'us-east-1',
      'acm:ValidationMethod': 'DNS',
      'acm:DomainNames': ['staging.example.org'],
    };
    expect(accepts(request)).toBe(true);
    expect(
      accepts({
        ...request,
        'aws:RequestedRegion': 'us-west-2',
        'acm:DomainNames': ['api.staging.example.org'],
      }),
    ).toBe(true);
    for (const names of [
      ['foreign.example.org'],
      ['staging.example.org', 'foreign.example.org'],
      ['*.example.org'],
    ]) {
      expect(accepts({ ...request, 'acm:DomainNames': names })).toBe(false);
    }
    expect(accepts({ 'aws:RequestedRegion': 'us-east-1', 'acm:ValidationMethod': 'DNS' })).toBe(
      false,
    );
    expect(
      accepts({
        ...request,
        'acm:CertificateAuthority':
          'arn:aws:acm-pca:us-east-1:123456789012:certificate-authority/test',
      }),
    ).toBe(false);
    expect(accepts({ ...request, 'acm:ValidationMethod': 'EMAIL' })).toBe(false);
    expect(accepts({ ...request, 'aws:RequestedRegion': 'eu-west-1' })).toBe(false);
  });
  it('keeps policies within IAM size limits and contains no CloudFormation YAML aliases', () => {
    for (const parameters of [DEFAULTS, EAST2_BEDROCK]) {
      const policies = Object.values(loadPolicies(parameters).byName);
      expect(policies).toHaveLength(4);
      for (const Statement of policies) {
        const document = { Version: '2012-10-17', Statement };
        expect(JSON.stringify(document).length).toBeLessThanOrEqual(6144);
      }
    }
    expect(readFileSync(file, 'utf8')).not.toMatch(/[&*]id\d+/);
  });
  it.each([DEFAULTS, EAST2_BEDROCK])(
    'does not grant whole services or unbounded role creation (%j)',
    (parameters) => {
      for (const statement of loadPolicies(parameters).statements.filter(
        (s) => s.Effect === 'Allow',
      )) {
        for (const action of actions(statement)) expect(action).not.toMatch(/^(\*|[^:]+:\*)$/);
        if (actions(statement).includes('iam:CreateRole')) {
          expect(JSON.stringify(statement.Resource)).toContain('role/Suas-');
          expect(JSON.stringify(statement.Condition)).toContain('iam:PermissionsBoundary');
          expect(JSON.stringify(statement.Condition)).toContain('SuasStagingRuntimeBoundary');
        }
      }
    },
  );
  it.each(['iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:UpdateAssumeRolePolicy'])(
    'requires the approved existing boundary on every allow path for %s',
    (action) => {
      const grants = statements.filter((s) => s.Effect === 'Allow' && actions(s).includes(action));
      expect(grants.length).toBeGreaterThan(0);
      for (const grant of grants) {
        // ArnEquals fails when the existing boundary is missing or differs; IfExists would not.
        expect(grant.Condition?.ArnEquals?.['iam:PermissionsBoundary']).toEqual({
          'Fn::Sub':
            'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/SuasStagingRuntimeBoundary',
        });
        expect(grant.Resource).toEqual({
          'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:role/Suas-*',
        });
      }
    },
  );
  it('requires the actual owner account and supported region on every S3 allow', () => {
    const grants = statements.filter(
      (s) => s.Effect === 'Allow' && actions(s).some((action) => action.startsWith('s3:')),
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      // A matching bucket-name prefix, including an account ID, is not ownership evidence.
      expect(grant.Condition?.StringEquals?.['s3:ResourceAccount']).toEqual({
        Ref: 'AWS::AccountId',
      });
      expect(grant.Condition?.StringEquals?.['aws:RequestedRegion']).toEqual([
        'us-west-2',
        'us-east-1',
      ]);
    }
  });
  it('explicitly denies removing, replacing or editing the runtime boundary', () => {
    const denied = statements.filter((s) => s.Effect === 'Deny');
    for (const action of [
      'iam:DeleteRolePermissionsBoundary',
      'iam:PutRolePermissionsBoundary',
      'iam:CreatePolicyVersion',
      'iam:SetDefaultPolicyVersion',
    ]) {
      expect(denied.some((s) => actions(s).includes(action))).toBe(true);
    }
    expect(
      JSON.stringify(denied.find((s) => s.Sid === 'CannotReplaceBoundary').Condition),
    ).toContain('ArnNotEquals');
  });
  it('applies the boundary to every generated role, including CDK helper roles', () => {
    const s = synthesize({ deploymentPipeline: 'true', vaSandbox: 'true' });
    let count = 0;
    for (const template of [s.dns, s.webCert, s.backend, s.web]) {
      for (const role of Object.values(template.findResources('AWS::IAM::Role'))) {
        count++;
        expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(
          'SuasStagingRuntimeBoundary',
        );
      }
    }
    expect(count).toBeGreaterThan(5);
    const parameters = s.backend.toJSON().Parameters;
    expect(parameters.AlarmEmail.NoEcho).toBe(true);
    expect(parameters.AlarmEmail).not.toHaveProperty('Default');
    expect(parameters.VaSandboxSecretArn).not.toHaveProperty('Default');
    s.backend.resourceCountIs('AWS::SNS::Topic', 1);
    s.backend.resourceCountIs('AWS::SNS::Subscription', 1);
    const topicPolicies = Object.values(s.backend.findResources('AWS::SNS::TopicPolicy'));
    expect(topicPolicies).toHaveLength(1);
    const publish = topicPolicies[0]!.Properties.PolicyDocument.Statement.find(
      (statement: { Principal?: { Service?: string } }) =>
        statement.Principal?.Service === 'cloudwatch.amazonaws.com',
    );
    expect(publish.Action).toBe('sns:Publish');
    expect(JSON.stringify(publish.Condition.StringEquals)).toContain('aws:SourceAccount');
    expect(JSON.stringify(publish.Condition.ArnLike)).toContain('alarm:Suas-');
  });
});

describe('region-restricted bootstrap and Bedrock grants', () => {
  const regionLists = (all: any[]) =>
    all
      .map((s) => s.Condition?.StringEquals?.['aws:RequestedRegion'])
      .filter((value) => Array.isArray(value));
  const guardrails = {
    'Fn::Sub': 'arn:${AWS::Partition}:bedrock:us-east-2:${AWS::AccountId}:guardrail/*',
  };

  it('defaults to the us-west-2 four-stack policies with no Bedrock grant', () => {
    const template = readFileSync(file, 'utf8');
    expect(template).toMatch(/StagingRegion:\n {4}Type: String\n {4}Default: us-west-2\n/);
    expect(template).toMatch(/ModelInference:\n {4}Type: String\n {4}Default: disabled\n/);
    expect(statements.flatMap(actions).filter((a) => a.startsWith('bedrock:'))).toEqual([]);
    for (const list of regionLists(statements)) expect(list).toEqual(['us-west-2', 'us-east-1']);
  });

  it('moves every regional grant to us-east-2 and keeps us-east-1 for edge services', () => {
    const east2 = loadPolicies({ ...DEFAULTS, StagingRegion: 'us-east-2' }).statements;
    expect(JSON.stringify(east2)).not.toContain('us-west-2');
    for (const list of regionLists(east2)) expect(list).toEqual(['us-east-2', 'us-east-1']);
    const rds = east2.find((s) => s.Sid === 'RdsEncryption');
    expect(rds.Condition.StringEquals['kms:ViaService']).toEqual({
      'Fn::Sub': 'rds.us-east-2.amazonaws.com',
    });
  });

  it('bounds the relay to one on-demand model in the staging Region and staging guardrails', () => {
    expect(readFileSync(file, 'utf8')).toMatch(
      /BedrockModelId:\n {4}Type: String\n {4}Default: qwen\.qwen3-32b-v1:0\n/,
    );
    const { byName } = loadPolicies(EAST2_BEDROCK);
    const boundary = byName.SuasStagingRuntimeBoundary!;
    const bedrock = boundary.filter((s: any) => actions(s).some((a) => a.startsWith('bedrock:')));
    expect(bedrock).toEqual([
      {
        Sid: 'InvokeFoundationModel',
        Effect: 'Allow',
        Action: 'bedrock:InvokeModel',
        // BedrockModelId keeps its default here, so CloudFormation fills it in at deploy.
        Resource: {
          'Fn::Sub': 'arn:${AWS::Partition}:bedrock:us-east-2::foundation-model/${BedrockModelId}',
        },
        Condition: { StringEquals: { 'aws:RequestedRegion': ['us-east-2'] } },
      },
      {
        Sid: 'ApplyGuardrail',
        Effect: 'Allow',
        Action: 'bedrock:ApplyGuardrail',
        Resource: guardrails,
        Condition: { StringEquals: { 'aws:RequestedRegion': 'us-east-2' } },
      },
    ]);
    // The API's relay invoke comes from the existing staging grant, not a second statement.
    const invoke = boundary.filter((s: any) => actions(s).includes('lambda:InvokeFunction'));
    expect(invoke).toHaveLength(1);
    expect(invoke[0].Resource).toEqual({
      'Fn::Sub': 'arn:${AWS::Partition}:lambda:*:${AWS::AccountId}:function:Suas-Staging-Backend-*',
    });
    expect(invoke[0].Condition.StringEquals['aws:RequestedRegion']).toEqual([
      'us-east-2',
      'us-east-1',
    ]);
  });

  // Review 2026-11-24 (#364): the parameter is an allowlist, not a pattern, so the policy can
  // only ever name the one reviewed model; another id fails at CloudFormation parameter checks.
  it('allows exactly one Bedrock model id', () => {
    expect(readFileSync(file, 'utf8')).toMatch(
      /BedrockModelId:\n {4}Type: String\n {4}Default: qwen\.qwen3-32b-v1:0\n {4}AllowedValues:\n {6}- qwen\.qwen3-32b-v1:0\n {4}Description:/,
    );
    expect(readFileSync(file, 'utf8')).not.toMatch(
      /BedrockModelId:[^]*?AllowedPattern[^]*?Conditions:/,
    );
  });

  // Review 2026-11-24 (#364): no Bedrock grant, in any policy, reaches us-east-1 or any Region
  // but the staging one; the edge-service us-east-1 entries stay on non-Bedrock statements.
  it('conditions every Bedrock statement on the staging Region alone', () => {
    const { statements: all } = loadPolicies(EAST2_BEDROCK);
    const bedrock = all.filter((s: any) => actions(s).some((a) => a.startsWith('bedrock:')));
    expect(bedrock.map((s: any) => s.Sid).sort()).toEqual([
      'ApplyGuardrail',
      'GuardrailCreate',
      'Guardrails',
      'InvokeFoundationModel',
    ]);
    for (const statement of bedrock) {
      expect([statement.Condition.StringEquals['aws:RequestedRegion']].flat()).toEqual([
        'us-east-2',
      ]);
      expect(JSON.stringify(statement)).not.toContain('us-east-1');
    }
  });

  it('lets CloudFormation manage only staging-Region guardrails', () => {
    const { byName } = loadPolicies(EAST2_BEDROCK);
    const services = byName.SuasCdkServices!;
    const region = { StringEquals: { 'aws:RequestedRegion': 'us-east-2' } };
    expect(services.find((s: any) => s.Sid === 'GuardrailCreate')).toEqual({
      Sid: 'GuardrailCreate',
      Effect: 'Allow',
      Action: 'bedrock:CreateGuardrail',
      Resource: '*',
      Condition: region,
    });
    const manage = services.find((s: any) => s.Sid === 'Guardrails');
    expect(manage.Resource).toEqual(guardrails);
    expect(manage.Condition).toEqual(region);
    expect([...actions(manage)].sort()).toEqual([
      'bedrock:CreateGuardrailVersion',
      'bedrock:DeleteGuardrail',
      'bedrock:GetGuardrail',
      'bedrock:ListTagsForResource',
      'bedrock:TagResource',
      'bedrock:UntagResource',
      'bedrock:UpdateGuardrail',
    ]);
  });
});
