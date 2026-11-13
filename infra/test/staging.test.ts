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
const parametersOf = (template: Synthesized['backend']): Record<string, Resource> =>
  (template.toJSON().Parameters ?? {}) as Record<string, Resource>;
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
    const zones = subnets.map(([, subnet]) => JSON.stringify(subnet.Properties?.AvailabilityZone));
    expect(new Set(zones).size).toBe(2);
    for (const [, subnet] of subnets) expect(subnet.Properties?.MapPublicIpOnLaunch).toBe(false);
  });

  it('reaches AWS through the S3 gateway endpoint and one interface endpoint per service used', () => {
    const endpoints = ofType(s.backend, 'AWS::EC2::VPCEndpoint').map(([, r]) => r.Properties);
    const byService = Object.fromEntries(
      endpoints.map((p) => [
        JSON.stringify(p?.ServiceName).replace(
          /.*(bedrock-runtime|email|execute-api|lambda|s3).*/,
          '$1',
        ),
        p,
      ]),
    );
    // Lambda, to invoke the SMTP relay (R11.2). No SES endpoint.
    expect(Object.keys(byService).sort()).toEqual(['lambda', 's3']);
    expect(byService.s3?.VpcEndpointType).toBe('Gateway');
    for (const name of ['lambda']) {
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
        expect(rule.CidrIpv6).toBeUndefined();
        expect(JSON.stringify(rule)).not.toContain('::/0');
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

  it('puts the API, job worker and migrate functions in the isolated subnets', () => {
    const handlers = functions()
      .map(([, r]) => r.Properties?.Handler)
      .sort();
    expect(handlers).toEqual(['job-worker.handler', 'migrate.handler', 'run.sh']);
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
    const resources = { ...resourcesOf(s.backend), ...parametersOf(s.backend) };
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
        expect(result.config.notifications.email).toBe('gmail_smtp');
        expect(result.config.notifications.smtp.relayFunction).toBeDefined();
        expect(result.config.modelInference.mode).toBe('disabled');
        expect(result.config.modelInference.bedrockModelId).toBeUndefined();
        expect(result.config.idVerification.mode).toBe('disabled');
        expect(result.config.publicSignUp).toBe(false);
        expect(result.config.stagingFixturePrincipals).toHaveLength(1);
        expect(result.config.stagingFixtureMailbox).toBe('fixture-mailbox@example.com');
        expect(result.config.corsAllowedOrigins).toEqual(['https://staging.suasqrf.com']);
        expect(result.config.chatPush.mode).toBe('disabled');
        expect(result.config.chatPush.publicUrl).toBeUndefined();
        expect(env.SUAS_CHAT_WS_ENDPOINT).toBeUndefined();
      }
    }
  });

  it('retains logs for a set time on every log group', () => {
    const groups = ofType(s.backend, 'AWS::Logs::LogGroup');
    expect(groups.length).toBeGreaterThanOrEqual(4);
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

describe('alarms', () => {
  it('counts the logged failure messages on the API and job worker logs and alarms on them', () => {
    const filters = ofType(s.backend, 'AWS::Logs::MetricFilter').map(([, r]) => r.Properties);
    expect(filters).toHaveLength(2);
    for (const filter of filters) {
      expect(filter?.FilterPattern).toBe('?"job_failed" ?"sweep_failed" ?"chat push failed"');
    }
    const alarms = ofType(s.backend, 'AWS::CloudWatch::Alarm').map(([, r]) => r.Properties);
    expect(alarms).toHaveLength(2);
    for (const alarm of alarms) {
      expect(alarm?.Threshold).toBe(1);
      // No notification target yet.
      expect(alarm?.AlarmActions).toBeUndefined();
    }
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

  it('lets the Lambda roles manage ENIs, including DescribeSubnets', () => {
    const eni = statements(s.backend).filter((st) =>
      [st.Action].flat().includes('ec2:CreateNetworkInterface'),
    );
    expect(eni).toHaveLength(3);
    for (const st of eni) {
      expect([st.Action].flat().sort()).toEqual([
        'ec2:AssignPrivateIpAddresses',
        'ec2:CreateNetworkInterface',
        'ec2:DeleteNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DescribeSubnets',
        'ec2:UnassignPrivateIpAddresses',
      ]);
    }
  });

  it('lets the API list the assets bucket, so a missing key is NoSuchKey and not AccessDenied', () => {
    const lists = statements(s.backend).filter((st) =>
      [st.Action].flat().includes('s3:ListBucket'),
    );
    expect(lists.length).toBeGreaterThan(0);
    for (const st of lists) {
      expect([st.Action].flat()).toEqual(['s3:ListBucket']);
      for (const resource of [st.Resource].flat()) {
        expect(resource).not.toBe('*');
        const text = JSON.stringify(resource);
        expect(text).toContain('AssetsBucket');
        expect(text).not.toContain('*');
      }
    }
  });

  it('grants neither SES nor Bedrock', () => {
    expect(
      statements(s.backend).some((st) => [st.Action].flat().some((a) => /^(bedrock|ses):/.test(a))),
    ).toBe(false);
  });
});

describe('SMTP relay (R11.2)', () => {
  type Policy = { Roles: Array<{ Ref: string }>; Statement: Array<Record<string, any>> };
  const policies = (): Policy[] =>
    ofType(s.backend, 'AWS::IAM::Policy').map(([, p]) => ({
      Roles: p.Properties?.Roles,
      Statement: p.Properties?.PolicyDocument.Statement,
    }));
  const relay = (): [string, Resource] => {
    const found = ofType(s.backend, 'AWS::Lambda::Function').find(
      ([, r]) => r.Properties?.Handler === 'smtp-relay.handler',
    );
    if (found === undefined) throw new Error('no relay function');
    return found;
  };
  const roleOf = (handler: string): string => {
    const fn = ofType(s.backend, 'AWS::Lambda::Function').find(
      ([, r]) => r.Properties?.Handler === handler,
    );
    return String(fn?.[1].Properties?.Role['Fn::GetAtt'][0]);
  };

  it('runs outside the VPC, with no database setting and only its secret id', () => {
    const [, fn] = relay();
    expect(fn.Properties?.VpcConfig).toBeUndefined();
    expect(Object.keys(fn.Properties?.Environment.Variables)).toEqual(['SUAS_SMTP_SECRET_ID']);
    expect(JSON.stringify(fn.Properties?.Environment.Variables)).toContain('SmtpRelayCredentials');
    expect(JSON.stringify(fn)).not.toMatch(/DATABASE_URL|ProxySg|DatabaseSg|LambdaSg/);
  });

  it('lets only the relay role read its secret, and the relay role nothing else', () => {
    const relayRole = roleOf('smtp-relay.handler');
    const reads = policies().filter((p) =>
      p.Statement.some((st) => JSON.stringify(st.Resource).includes('SmtpRelayCredentials')),
    );
    expect(reads.map((p) => p.Roles.map((r) => r.Ref))).toEqual([[relayRole]]);
    const relayPolicies = policies().filter((p) => p.Roles.some((r) => r.Ref === relayRole));
    expect(relayPolicies).toHaveLength(1);
    for (const st of relayPolicies[0]?.Statement ?? []) {
      const actions = [st.Action].flat() as string[];
      expect(actions.every((a) => /^(secretsmanager|logs):/.test(a))).toBe(true);
      if (actions.some((a) => a.startsWith('secretsmanager:'))) {
        expect(JSON.stringify(st.Resource)).toContain('SmtpRelayCredentials');
        expect(st.Resource).not.toBe('*');
      }
    }
  });

  it('lets the API and job worker invoke only the relay, and the relay invoke nothing', () => {
    const invokesRelay = (p: Policy): boolean =>
      p.Statement.some(
        (st) =>
          [st.Action].flat().includes('lambda:InvokeFunction') &&
          JSON.stringify(st.Resource).includes('SmtpRelayFunction'),
      );
    const invokers = policies().filter(invokesRelay);
    expect(invokers.flatMap((p) => p.Roles.map((r) => r.Ref)).sort()).toEqual(
      [roleOf('run.sh'), roleOf('job-worker.handler')].sort(),
    );
    // Those roles invoke nothing but the relay (the scheduler's own role invokes the worker).
    for (const policy of invokers) {
      for (const st of policy.Statement.filter((x) =>
        [x.Action].flat().includes('lambda:InvokeFunction'),
      )) {
        for (const resource of [st.Resource].flat()) {
          expect(JSON.stringify(resource)).toContain('SmtpRelayFunction');
        }
      }
    }
  });

  it('keeps the app password out of every function environment', () => {
    for (const [, fn] of ofType(s.backend, 'AWS::Lambda::Function')) {
      const variables = (fn.Properties?.Environment?.Variables ?? {}) as Record<string, unknown>;
      expect(variables).not.toHaveProperty('SUAS_SMTP_APP_PASSWORD');
      expect(variables).not.toHaveProperty('SUAS_EMAIL_FROM');
    }
  });
});

// suas-specs SCRY_LICENCE_FALLBACK.md (R10.1 proposal) §2.3, L4.7, L9 and
// VA_CONFIRMATION_FLOW.md §2.1: licence images leave no copies, the worker sees only their
// prefix, the new secrets reach only their holders, and the reader stays off with no egress.
describe('licence review', () => {
  type Statement = { Action: string | string[]; Resource: unknown; Condition?: unknown };
  const assetsBucket = (): Resource | undefined =>
    ofType(s.backend, 'AWS::S3::Bucket').find(([id]) => id.startsWith('AssetsBucket'))?.[1];
  const envByHandler = (): Record<string, Record<string, unknown>> =>
    Object.fromEntries(
      ofType(s.backend, 'AWS::Lambda::Function')
        .filter(([, r]) => r.Properties?.VpcConfig !== undefined)
        .map(([, r]) => [
          String(r.Properties?.Handler),
          r.Properties?.Environment.Variables as Record<string, unknown>,
        ]),
    );
  const s3StatementsOf = (roleIdPrefix: string): Statement[] => {
    const roleId = ofType(s.backend, 'AWS::IAM::Role').find(([id]) =>
      id.startsWith(roleIdPrefix),
    )?.[0];
    expect(roleId, roleIdPrefix).toBeDefined();
    return ofType(s.backend, 'AWS::IAM::Policy')
      .filter(([, p]) => JSON.stringify(p.Properties?.Roles).includes(`"${String(roleId)}"`))
      .flatMap(([, p]) => p.Properties?.PolicyDocument.Statement as Statement[])
      .filter((st) => [st.Action].flat().some((a) => a.startsWith('s3:')));
  };
  // The secret reaches exactly `holders`, only as a dynamic reference under `variable`, and
  // no role can read it at run time (CloudFormation resolves it at deploy).
  const expectSecretOnlyIn = (variable: string, holders: string[]): void => {
    const ids = ofType(s.backend, 'AWS::SecretsManager::Secret')
      .filter(([, r]) => String(r.Properties?.Description).startsWith(`${variable}:`))
      .map(([id]) => id);
    expect(ids).toHaveLength(1);
    const id = ids[0] ?? '';
    const envs = envByHandler();
    expect(Object.keys(envs).sort()).toEqual(['job-worker.handler', 'migrate.handler', 'run.sh']);
    for (const [handler, variables] of Object.entries(envs)) {
      expect(JSON.stringify(variables).includes(id), handler).toBe(holders.includes(handler));
      if (!holders.includes(handler)) continue;
      const value = JSON.stringify(variables[variable]);
      expect(value, handler).toContain('{{resolve:secretsmanager:');
      expect(value, handler).toContain(id);
    }
    for (const [, policy] of ofType(s.backend, 'AWS::IAM::Policy')) {
      expect(JSON.stringify(policy.Properties?.PolicyDocument)).not.toContain(id);
    }
  };

  it('keeps no copies: the image bucket has no versioning or replication, and no AWS Backup', () => {
    const bucket = assetsBucket();
    expect(bucket).toBeDefined();
    expect(bucket?.Properties?.VersioningConfiguration).toBeUndefined();
    expect(bucket?.Properties?.ReplicationConfiguration).toBeUndefined();
    for (const template of [s.dns, s.webCert, s.backend, s.web]) {
      const types = Object.values(resourcesOf(template)).map((r) => r.Type);
      expect(types.filter((t) => t.startsWith('AWS::Backup::'))).toEqual([]);
    }
  });

  it('expires licence-reviews/ after 30 days and aborts unfinished uploads after 1', () => {
    expect(assetsBucket()?.Properties?.LifecycleConfiguration.Rules).toEqual([
      {
        Id: 'LicenceReviewsBackstop',
        Prefix: 'licence-reviews/',
        ExpirationInDays: 30,
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
        Status: 'Enabled',
      },
    ]);
  });

  it('lets the job worker get and delete licence images only, and list the bucket unconditioned', () => {
    const worker = envByHandler()['job-worker.handler'];
    expect(worker?.SUAS_OBJECT_STORAGE_MODE).toBe('s3');
    expect(JSON.stringify(worker?.SUAS_S3_BUCKET)).toContain('AssetsBucket');
    const statements = s3StatementsOf('JobWorkerFunctionRole');
    expect(statements).toHaveLength(2);
    const objects = statements.find(
      (st) => !([st.Action].flat() as string[]).includes('s3:ListBucket'),
    );
    expect([objects?.Action].flat().sort()).toEqual(['s3:DeleteObject', 's3:GetObject']);
    expect(JSON.stringify(objects?.Resource)).toMatch(/AssetsBucket.*\/licence-reviews\/\*"/);
    const list = statements.find((st) => [st.Action].flat().includes('s3:ListBucket'));
    expect([list?.Action].flat()).toEqual(['s3:ListBucket']);
    // Unconditioned, so a missing key is NoSuchKey (404) as AWS documents, not AccessDenied.
    expect(list?.Condition).toBeUndefined();
    expect(JSON.stringify(list?.Resource)).not.toContain('*');
  });

  it('lets the API put, get and delete licence images through its bucket-wide object grant', () => {
    const objects = s3StatementsOf('ApiFunctionRole').find((st) =>
      [st.Action].flat().includes('s3:PutObject'),
    );
    expect([objects?.Action].flat().sort()).toEqual([
      's3:DeleteObject',
      's3:GetObject',
      's3:PutObject',
    ]);
    expect(JSON.stringify(objects?.Resource)).toMatch(/AssetsBucket.*\/\*"/);
  });

  it('gives the reader token to the job worker only', () => {
    expectSecretOnlyIn('SUAS_SCRY_API_TOKEN', ['job-worker.handler']);
  });

  it('gives the fingerprint key and its id to the API and job worker only', () => {
    expectSecretOnlyIn('SUAS_FINGERPRINT_KEY', ['job-worker.handler', 'run.sh']);
    for (const [handler, variables] of Object.entries(envByHandler())) {
      const expected = handler === 'migrate.handler' ? undefined : 'staging-1';
      expect(variables.SUAS_FINGERPRINT_KEY_ID, handler).toBe(expected);
    }
  });

  it('keeps the reader disabled with no reader URL on every function', () => {
    for (const [handler, variables] of Object.entries(envByHandler())) {
      expect(variables.SUAS_LICENCE_READER_MODE, handler).toBe('disabled');
      expect(variables.SUAS_SCRY_BASE_URL, handler).toBeUndefined();
    }
  });
});

describe('DNS and email', () => {
  it('owns a retained public zone and creates no apex or www record', () => {
    s.dns.hasResource('AWS::Route53::HostedZone', {
      Properties: { Name: 'suasqrf.com.' },
      DeletionPolicy: 'Retain',
    });
    // Only the mail records carried over from Cloudflare, all on subdomains.
    const records = ofType(s.dns, 'AWS::Route53::RecordSet').map(
      ([, r]) => `${r.Properties?.Type} ${r.Properties?.Name}`,
    );
    expect(records.sort()).toEqual([
      'MX send.suasqrf.com.',
      'TXT resend._domainkey.suasqrf.com.',
      'TXT send.suasqrf.com.',
    ]);
    s.dns.hasOutput('NameServers', Match.anyValue());
  });

  it('has no SES identity (R11.2 sends through Gmail)', () => {
    s.dns.resourceCountIs('AWS::SES::EmailIdentity', 0);
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
    ]);
  });
});

describe('configuration and hygiene', () => {
  it('refuses a Bedrock model id so inference cannot be turned on from context', () => {
    expect(() => synthesize({ bedrockModelId: 'us.example.model-v1:0' })).toThrow(/R2\.15/);
    expect(() => createStagingApp(new App())).not.toThrow();
  });

  it('rejects a hostname outside the hosted zone', () => {
    expect(() => synthesize({ webHostname: 'staging.example.com' })).toThrow(/inside suasqrf\.com/);
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
