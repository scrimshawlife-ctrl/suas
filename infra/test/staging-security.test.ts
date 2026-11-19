import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { describe, expect, it } from 'vitest';
import { synthesize } from './helpers.js';

const file = new URL('../bootstrap/cfn-execution-policy.yaml', import.meta.url).pathname;
const stack = new Stack(new App(), 'PolicyTest');
new CfnInclude(stack, 'BootstrapPolicies', {
  templateFile: file,
  parameters: {
    StagingApiHostname: 'api.staging.example.org',
    StagingWebHostname: 'staging.example.org',
  },
});
const policies = Object.values(Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy'));
const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
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
    expect(policies).toHaveLength(4);
    for (const policy of policies) {
      expect(JSON.stringify(policy.Properties.PolicyDocument).length).toBeLessThanOrEqual(6144);
    }
    expect(readFileSync(file, 'utf8')).not.toMatch(/[&*]id\d+/);
  });
  it('does not grant whole services or unbounded role creation', () => {
    for (const statement of statements.filter((s) => s.Effect === 'Allow')) {
      for (const action of actions(statement)) expect(action).not.toMatch(/^(\*|[^:]+:\*)$/);
      if (actions(statement).includes('iam:CreateRole')) {
        expect(JSON.stringify(statement.Resource)).toContain('role/Suas-');
        expect(JSON.stringify(statement.Condition)).toContain('iam:PermissionsBoundary');
        expect(JSON.stringify(statement.Condition)).toContain('SuasStagingRuntimeBoundary');
      }
    }
  });
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
