/**
 * Properties of the STAGING stacks that matter. Everything runs offline against the
 * in-memory synthesized templates.
 */

import { App } from 'aws-cdk-lib';
import { Match } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { tryLoadConfig } from '../../src/config/index.js';
import { resolveForValidation, synthesize, type Synthesized } from './helpers.js';
import { createStagingApp } from '../lib/staging.js';

let s: Synthesized;
beforeAll(() => {
  s = synthesize();
});

type Resource = { Type: string; Properties?: Record<string, any> };
const resourcesOf = (template: Synthesized['backend']): Record<string, Resource> =>
  template.toJSON().Resources as Record<string, Resource>;
const ofType = (template: Synthesized['backend'], type: string): Array<[string, Resource]> =>
  Object.entries(resourcesOf(template)).filter(([, r]) => r.Type === type);

describe('network', () => {
  it('has no NAT gateway, no internet gateway and no route to one', () => {
    s.backend.resourceCountIs('AWS::EC2::NatGateway', 0);
    s.backend.resourceCountIs('AWS::EC2::InternetGateway', 0);
    s.backend.resourceCountIs('AWS::EC2::VPCGatewayAttachment', 0);
    for (const [, route] of ofType(s.backend, 'AWS::EC2::Route')) {
      expect(route.Properties).not.toHaveProperty('GatewayId');
      expect(route.Properties).not.toHaveProperty('NatGatewayId');
    }
  });

  it('spreads isolated subnets over two zones, with no public IPs', () => {
    const subnets = ofType(s.backend, 'AWS::EC2::Subnet');
    expect(subnets).toHaveLength(2);
    for (const [, subnet] of subnets) expect(subnet.Properties?.MapPublicIpOnLaunch).toBe(false);
  });

  it('reaches AWS through the S3 gateway endpoint and one interface endpoint per service used', () => {
    const endpoints = ofType(s.backend, 'AWS::EC2::VPCEndpoint').map(([, r]) => r.Properties);
    const byService = Object.fromEntries(
      endpoints.map((p) => [
        JSON.stringify(p?.ServiceName).replace(/.*(bedrock-runtime|email|execute-api|s3).*/, '$1'),
        p,
      ]),
    );
    expect(Object.keys(byService).sort()).toEqual([
      'bedrock-runtime',
      'email',
      'execute-api',
      's3',
    ]);
    expect(byService.s3?.VpcEndpointType).toBe('Gateway');
    for (const name of ['bedrock-runtime', 'email', 'execute-api']) {
      expect(byService[name]?.VpcEndpointType).toBe('Interface');
      expect(byService[name]?.PrivateDnsEnabled).toBe(true);
    }
  });

  it('allows only Lambda to Proxy to RDS on 5432 (plus migrate to RDS), and HTTPS to endpoints', () => {
    const databasePort = (port: unknown): boolean =>
      port === 5432 || JSON.stringify(port).includes('Endpoint.Port');
    const separate = [
      ...ofType(s.backend, 'AWS::EC2::SecurityGroupIngress'),
      ...ofType(s.backend, 'AWS::EC2::SecurityGroupEgress'),
    ].map(([, r]) => r.Properties);
    for (const rule of separate) {
      expect(rule?.IpProtocol).toBe('tcp');
      expect(rule?.CidrIp).toBeUndefined();
      expect(rule?.FromPort === 443 || databasePort(rule?.FromPort)).toBe(true);
      expect(rule?.FromPort).toEqual(rule?.ToPort);
    }
    // Inline rules: nothing accepts traffic from a CIDR, and the one open-destination rule is
    // HTTPS egress, which only reaches the VPC endpoints because the subnets have no other route.
    for (const [, group] of ofType(s.backend, 'AWS::EC2::SecurityGroup')) {
      expect(group.Properties?.SecurityGroupIngress).toBeUndefined();
      for (const rule of (group.Properties?.SecurityGroupEgress ?? []) as Array<
        Record<string, unknown>
      >) {
        if (rule.CidrIp === '255.255.255.255/32') continue; // CDK's "no outbound" placeholder.
        expect(rule).toMatchObject({
          CidrIp: '0.0.0.0/0',
          IpProtocol: 'tcp',
          FromPort: 443,
          ToPort: 443,
        });
      }
    }
  });
});

describe('database', () => {
  it('is PostgreSQL 17 on db.t4g.micro, encrypted, private, single-AZ, backed up and protected', () => {
    s.backend.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^17'),
      DBInstanceClass: 'db.t4g.micro',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      MultiAZ: false,
      AllocatedStorage: '20',
      StorageType: 'gp3',
      BackupRetentionPeriod: 7,
      DeletionProtection: true,
    });
  });

  it('is reached through an RDS Proxy that requires TLS and holds the generated secret', () => {
    s.backend.hasResourceProperties('AWS::RDS::DBProxy', {
      EngineFamily: 'POSTGRESQL',
      RequireTLS: true,
      Auth: [Match.objectLike({ AuthScheme: 'SECRETS' })],
    });
    s.backend.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: Match.objectLike({ SecretStringTemplate: Match.anyValue() }),
    });
  });

  it('names nothing the config guard would read as a production database', () => {
    const text = JSON.stringify(resourcesOf(s.backend));
    expect(text).not.toMatch(
      /"(DBInstanceIdentifier|DBProxyName|DBName)":"[^"]*\b(prod|production|live)\b/,
    );
  });
});

describe('buckets', () => {
  it('block all public access and require TLS', () => {
    for (const template of [s.backend, s.web]) {
      const buckets = ofType(template, 'AWS::S3::Bucket');
      expect(buckets.length).toBeGreaterThan(0);
      for (const [, bucket] of buckets) {
        expect(bucket.Properties?.PublicAccessBlockConfiguration).toEqual({
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        });
      }
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    }
  });
});

describe('web distribution', () => {
  it('reads the private bucket through Origin Access Control, over HTTPS, with SPA fallback', () => {
    s.web.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    s.web.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
    s.web.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Aliases: ['staging.suasqrf.com'],
        DefaultRootObject: 'index.html',
        DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'redirect-to-https' }),
        Origins: [Match.objectLike({ OriginAccessControlId: Match.anyValue() })],
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({ ErrorCode: 403, ResponseCode: 200, ResponsePagePath: '/index.html' }),
          Match.objectLike({ ErrorCode: 404, ResponseCode: 200, ResponsePagePath: '/index.html' }),
        ]),
      }),
    });
  });

  it('uses a certificate from the us-east-1 stack', () => {
    expect(s.stacks.webCert.region).toBe('us-east-1');
    s.webCert.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'staging.suasqrf.com',
      ValidationMethod: 'DNS',
    });
  });
});

describe('functions', () => {
  const functions = (): Array<[string, Resource]> =>
    ofType(s.backend, 'AWS::Lambda::Function').filter(
      ([, r]) =>
        r.Properties?.Handler !== undefined &&
        r.Properties?.Runtime === 'nodejs22.x' &&
        r.Properties?.VpcConfig !== undefined,
    );

  it('puts the API, WebSocket, job worker and migrate functions in the isolated subnets', () => {
    const handlers = functions()
      .map(([, r]) => r.Properties?.Handler)
      .sort();
    expect(handlers).toEqual([
      'job-worker.handler',
      'migrate.handler',
      'run.sh',
      'websocket.handler',
    ]);
    const subnetIds = ofType(s.backend, 'AWS::EC2::Subnet').map(([id]) => id);
    for (const [, fn] of functions()) {
      const refs = (fn.Properties?.VpcConfig.SubnetIds as Array<{ Ref: string }>).map((r) => r.Ref);
      expect(refs.sort()).toEqual([...subnetIds].sort());
    }
  });

  it('runs the API on Node 22 behind the Lambda Web Adapter', () => {
    s.backend.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'run.sh',
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
          SUAS_HTTP_HOST: '0.0.0.0',
        }),
      },
      Layers: [Match.stringLikeRegexp('LambdaAdapterLayerArm64')],
    });
  });

  it('keeps secrets out of the template as dynamic references', () => {
    for (const [, fn] of functions()) {
      const variables = fn.Properties?.Environment.Variables as Record<string, unknown>;
      for (const name of ['SUAS_SESSION_SECRET', 'DATABASE_URL']) {
        expect(JSON.stringify(variables[name])).toContain('{{resolve:secretsmanager:');
      }
    }
  });

  it('gives every function a configuration the application accepts', () => {
    const resources = resourcesOf(s.backend);
    for (const [name, fn] of functions()) {
      const env = Object.fromEntries(
        Object.entries(fn.Properties?.Environment.Variables as Record<string, unknown>).map(
          ([k, v]) => [k, resolveForValidation(v, resources)],
        ),
      );
      const result = tryLoadConfig(env);
      expect(result.ok ? [] : result.issues, name).toEqual([]);
      if (result.ok && fn.Properties?.Handler === 'run.sh') {
        expect(result.config.environment).toBe('STAGING');
        expect(result.config.notifications.email).toBe('ses');
        expect(result.config.modelInference.mode).toBe('bedrock');
        expect(result.config.idVerification.mode).toBe('fake');
        expect(result.config.corsAllowedOrigins).toEqual(['https://staging.suasqrf.com']);
        expect(result.config.chatPush.publicUrl).toBe('wss://ws.staging.suasqrf.com');
      }
    }
  });

  it('retains logs for a set time on every log group', () => {
    const groups = ofType(s.backend, 'AWS::Logs::LogGroup');
    expect(groups.length).toBeGreaterThanOrEqual(5);
    for (const [, group] of groups) expect(group.Properties?.RetentionInDays).toBe(30);
  });

  it('writes an access log with metadata only, never bodies, paths or addresses', () => {
    const stage = ofType(s.backend, 'AWS::ApiGatewayV2::Stage').find(
      ([, r]) => r.Properties?.AccessLogSettings !== undefined,
    );
    const format = String(stage?.[1].Properties?.AccessLogSettings.Format);
    expect(format).toContain('$context.requestId');
    expect(format).not.toMatch(/path|body|queryString|sourceIp|identity/i);
  });
});

describe('IAM', () => {
  const statements = (template: Synthesized['backend']) =>
    ofType(template, 'AWS::IAM::Policy').flatMap(
      ([, p]) =>
        (p.Properties?.PolicyDocument.Statement ?? []) as Array<{
          Action: string | string[];
          Resource: unknown;
          Effect: string;
        }>,
    );

  it('never uses a wildcard resource for Bedrock or SES actions', () => {
    const sensitive = statements(s.backend).filter((st) =>
      [st.Action].flat().some((a) => /^(bedrock|ses):/.test(a)),
    );
    expect(sensitive.length).toBeGreaterThanOrEqual(2);
    for (const st of sensitive) {
      for (const resource of [st.Resource].flat())
        expect(JSON.stringify(resource)).not.toMatch(/^"\*"$/);
    }
  });

  it('scopes Bedrock to the configured model and SES to the domain identity', () => {
    const bedrock = statements(s.backend).find((st) =>
      [st.Action].flat().includes('bedrock:InvokeModel'),
    );
    expect(JSON.stringify(bedrock?.Resource)).toContain(
      'foundation-model/placeholder.ci-synth-only-model-v1:0',
    );
    const ses = statements(s.backend).find((st) => [st.Action].flat().includes('ses:SendEmail'));
    expect(JSON.stringify(ses?.Resource)).toContain('identity/suasqrf.com');
  });

  it('scopes an inference profile model to the profile plus the underlying foundation model', () => {
    const profile = synthesize({ bedrockModelId: 'us.example.model-v1:0' });
    const bedrock = statements(profile.backend).find((st) =>
      [st.Action].flat().includes('bedrock:InvokeModel'),
    );
    const text = JSON.stringify(bedrock?.Resource);
    expect(text).toContain('inference-profile/us.example.model-v1:0');
    expect(text).toContain('foundation-model/example.model-v1:0');
    expect(text).not.toMatch(/"\*"/);
  });
});

describe('DNS and email', () => {
  it('owns a retained public zone for the root domain and creates no apex or www record', () => {
    s.dns.hasResource('AWS::Route53::HostedZone', {
      Properties: { Name: 'suasqrf.com.' },
      DeletionPolicy: 'Retain',
    });
    const records = ofType(s.dns, 'AWS::Route53::RecordSet').map(([, r]) => r.Properties);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record?.Type).toBe('CNAME');
      expect(JSON.stringify(record?.Name)).toContain('DkimDNSTokenName');
    }
    s.dns.hasOutput('NameServers', Match.anyValue());
  });

  it('has a DKIM-signed SES domain identity', () => {
    s.dns.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'suasqrf.com' });
  });

  it('points only the staging hostnames at AWS', () => {
    const names = [
      ...ofType(s.backend, 'AWS::Route53::RecordSet'),
      ...ofType(s.web, 'AWS::Route53::RecordSet'),
    ].map(([, r]) => String(r.Properties?.Name));
    expect(names.sort()).toEqual([
      'api.staging.suasqrf.com.',
      'staging.suasqrf.com.',
      'staging.suasqrf.com.',
      'ws.staging.suasqrf.com.',
    ]);
  });
});

describe('configuration and hygiene', () => {
  it('fails with a clear message when the Bedrock model is not given', () => {
    expect(() => createStagingApp(new App())).toThrow(/bedrockModelId.*not chosen yet/s);
  });

  it('marks a placeholder-model synth so it is not mistaken for a deployable one', () => {
    expect(s.stacks.backend.templateOptions.description).toContain('PLACEHOLDER MODEL');
    const real = synthesize({ bedrockModelId: 'us.example.model-v1:0' });
    expect(real.stacks.backend.templateOptions.description).not.toContain('PLACEHOLDER');
  });

  it('rejects a hostname outside the hosted zone', () => {
    expect(() =>
      synthesize({ allowPlaceholderModel: 'true', webHostname: 'staging.example.com' }),
    ).toThrow(/inside suasqrf\.com/);
  });

  it('contains no AWS account id (the Lambda Web Adapter layer publisher is AWS-owned)', () => {
    const publisher = '753240598075';
    for (const template of [s.dns, s.webCert, s.backend, s.web]) {
      const ids =
        JSON.stringify(template.toJSON()).match(/(?<![0-9A-Za-z-])[0-9]{12}(?![0-9A-Za-z-])/g) ??
        [];
      expect(ids.filter((id) => id !== publisher)).toEqual([]);
    }
  });
});
