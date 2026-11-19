import { readFileSync } from 'node:fs';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CfnInclude } from 'aws-cdk-lib/cloudformation-include';
import { describe, expect, it } from 'vitest';
import { synthesize } from './helpers.js';

const file = new URL('../bootstrap/cfn-execution-policy.yaml', import.meta.url).pathname;
const stack = new Stack(new App(), 'PolicyTest');
new CfnInclude(stack, 'BootstrapPolicies', { templateFile: file });
const policies = Object.values(Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy'));
const statements = policies.flatMap((p) => p.Properties.PolicyDocument.Statement);
const actions = (s: { Action: string | string[] }): string[] => [s.Action].flat();

describe('staging privilege boundary', () => {
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
