/**
 * The STAGING backend (synthetic data only): network, database, the API, the scheduled
 * job worker, the migrate function, the email relay, and the assets bucket. Inference stays disabled
 * (R2.15 is not approved) and chat push stays off (R6.12 is not accepted). The Bedrock
 * and API Gateway push adapters remain in src/ and are not selected here.
 *
 * Design rules (user decisions of 2026-11-05):
 *  - The VPC has isolated subnets only. There is no NAT gateway and no internet gateway
 *    route. Lambdas reach AWS through a gateway endpoint (S3) and interface endpoints for
 *    the services the code calls, and nothing else.
 *  - Every in-VPC Lambda connects to the RDS instance endpoint directly with verified TLS; the
 *    Lambda interface endpoint sits in one zone. Lean synthetic STAGING (R14.1 proposal);
 *    infra/README.md "Before production" restores RDS Proxy and a multi-AZ endpoint.
 *  - Secrets live in Secrets Manager. The application reads configuration from environment
 *    variables only, so each secret is injected as a CloudFormation dynamic reference that
 *    CloudFormation resolves at deploy time; the template never contains the value.
 */

import { CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwIntegrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../../src/release/pins.js';
import { REGION, type EnvironmentConfig } from './config.js';
import { RDS_CA_BUNDLE_FILE, suasLambdaCode } from './lambda-code.js';
import { applyDeploymentMode, deploymentPipelineEnabled } from './deployment-mode.js';
import { EmailRelay } from './email-relay.js';
import { VaVerify } from './va-verify.js';

export interface BackendStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly zone: route53.IHostedZone;
}

const DB_NAME = 'suas';
const DB_PORT = 5432;
const API_PORT = '8080';
const LOG_RETENTION = logs.RetentionDays.ONE_MONTH;
/** The AWS-published Lambda Web Adapter layer lives in an AWS-owned account. */
const WEB_ADAPTER_LAYER_PUBLISHER = '753240598075';
/** Licence review images (suas-specs SCRY_LICENCE_FALLBACK.md §2.3, R10.1, released in 0.10.0). */
const LICENCE_REVIEWS_PREFIX = 'licence-reviews/';
/**
 * Stored beside every keyed hash (VA_CONFIRMATION_FLOW.md §2.1). Change it whenever the key
 * changes, and move the old pair to the `_PREVIOUS` variables.
 */
const FINGERPRINT_KEY_ID = 'staging-1';
// R14.1 (SUAS-specs #100): with no RDS Proxy these caps bound database connections to
// API 15 x pool 3 + worker 2 x pool 3 + migrate 1 x pool 1 = 52, under db.t4g.micro's ~80 usable.
const API_RESERVED_CONCURRENCY = 15;
const JOB_WORKER_RESERVED_CONCURRENCY = 2;
const MIGRATE_RESERVED_CONCURRENCY = 1;
// Pinned below the memory formula's default (at most 112 on db.t4g.micro), so the budget above is
// checked against the limit the instance really has. A static parameter: changing it needs a reboot.
const DB_MAX_CONNECTIONS = 80;
const DB_CONNECTIONS_ALARM = 70;

type Env = Record<string, string>;

/** SSM parameter `/suas/<environment>/<name>` (fixture-registry, fixture-mailbox, email-from). */
export function fixtureParameterName(environment: string, name: string): string {
  return `/suas/${environment}/${name}`;
}

export class BackendStack extends Stack {
  private readonly zoneNames: string[];

  /**
   * The zones CloudFormation resolves (or the pinned context list). Overriding the getter keeps
   * an account-bound synth lookup-free: the default asks the account for its zones.
   */
  override get availabilityZones(): string[] {
    return this.zoneNames;
  }

  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);
    const { config, zone } = props;
    this.zoneNames =
      config.availabilityZones.length > 0
        ? [...config.availabilityZones]
        : [Fn.select(0, Fn.getAzs(REGION)), Fn.select(1, Fn.getAzs(REGION))];
    const isolated: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    // ---------------------------------------------------------------- network
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      availabilityZones: this.zoneNames,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'API and job worker functions',
      allowAllOutbound: false,
    });
    const migrateSg = new ec2.SecurityGroup(this, 'MigrateSg', {
      vpc,
      description: 'Migrate function (connects to the instance directly)',
      allowAllOutbound: false,
    });
    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'RDS instance',
      allowAllOutbound: false,
    });
    const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
      vpc,
      description: 'Interface VPC endpoints',
      allowAllOutbound: false,
    });

    // Lambda -> RDS and migrate -> RDS on 5432. Nothing else. Migrate keeps its own group
    // because it needs no HTTPS egress.
    for (const [sg, label] of [
      [lambdaSg, 'Lambda'],
      [migrateSg, 'Migrate'],
    ] as const) {
      dbSg.connections.allowFrom(sg, ec2.Port.tcp(DB_PORT), `${label} to RDS`);
      sg.connections.allowTo(dbSg, ec2.Port.tcp(DB_PORT), `${label} to RDS`);
    }
    // HTTPS to the interface endpoints and, through the gateway endpoint, S3. These are the
    // only routes out of the subnets, so a wide destination here reaches nothing else.
    endpointSg.connections.allowFrom(lambdaSg, ec2.Port.tcp(443), 'Lambda to VPC endpoints');
    lambdaSg.connections.allowTo(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'AWS APIs via VPC endpoints',
    );

    vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    // One interface endpoint per AWS service the code calls (see README for the source files).
    // Lambda only, to invoke the email relay (suas #305) and, with vaSandbox, the VA verify
    // function (VA_CONFIRMATION_FLOW W9 item 4). Bedrock Runtime and execute-api are not
    // endpoints while inference and chat push stay off.
    const interfaceEndpoints: ReadonlyArray<readonly [string, ec2.InterfaceVpcEndpointAwsService]> =
      [['LambdaEndpoint', ec2.InterfaceVpcEndpointAwsService.LAMBDA]];
    // R14.1 proposal: one zone only (the first isolated subnet). Private DNS resolves to that
    // ENI from both zones over the VPC's local route; losing that zone stops relay invokes.
    const endpointSubnets: ec2.SubnetSelection = { subnets: vpc.isolatedSubnets.slice(0, 1) };
    for (const [endpointId, service] of interfaceEndpoints) {
      vpc.addInterfaceEndpoint(endpointId, {
        service,
        subnets: endpointSubnets,
        securityGroups: [endpointSg],
        // Only the Lambda security group may reach the endpoints, not the whole VPC CIDR.
        open: false,
        privateDnsEnabled: true,
      });
    }

    // --------------------------------------------------------------- database
    const dbParameters = new rds.ParameterGroup(this, 'DatabaseParameters', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      parameters: { 'rds.force_ssl': '1', max_connections: String(DB_MAX_CONNECTIONS) },
    });
    const database = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: `suas-${config.name}`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      parameterGroup: dbParameters,
      caCertificate: rds.CaCertificate.RDS_CA_RSA2048_G1,
      vpc,
      vpcSubnets: isolated,
      securityGroups: [dbSg],
      publiclyAccessible: false,
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(7),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      databaseName: DB_NAME,
      credentials: rds.Credentials.fromGeneratedSecret('suas_admin', {
        // URL-safe, so the password can sit inside DATABASE_URL unescaped.
        excludeCharacters: '"%+~`#$&*()|[]{}:;<>?!\'/@\\=,^-._ ',
      }),
    });
    const dbSecret = database.secret;
    if (dbSecret === undefined) throw new Error('The database must have a generated secret.');

    const dbUser = dbSecret.secretValueFromJson('username').unsafeUnwrap();
    const dbPassword = dbSecret.secretValueFromJson('password').unsafeUnwrap();
    // Every in-VPC function connects to the instance itself (no RDS Proxy, R14.1 proposal), so
    // each verifies the instance certificate against the shipped RDS CA bundle.
    const directDatabase: Env = {
      DATABASE_URL: Fn.join('', [
        'postgresql://',
        dbUser,
        ':',
        dbPassword,
        '@',
        database.dbInstanceEndpointAddress,
        `:${String(DB_PORT)}/${DB_NAME}`,
      ]),
      DATABASE_SSL_CA_FILE: `/var/task/${RDS_CA_BUNDLE_FILE}`,
    };

    // ---------------------------------------------------------------- storage
    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
      // Licence images must leave no copies (§2.3): no versioning, no replication, and no
      // AWS Backup plan covers this bucket. Tests fail if any of these appear.
      versioned: false,
      lifecycleRules: [
        {
          // Backstop only: the app deletes the images at the decision, and settles an open
          // review as PHOTOS_EXPIRED before this age.
          id: 'LicenceReviewsBackstop',
          prefix: LICENCE_REVIEWS_PREFIX,
          expiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
      ],
    });

    const sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      description: 'SUAS_SESSION_SECRET: keys challenge and session credential hashing',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    // Keys the VA and licence hashes. 64 letters and digits are valid base64 of 48 bytes,
    // which the config validator requires (at least 32).
    const fingerprintKeySecret = new secretsmanager.Secret(this, 'FingerprintKeySecret', {
      description: 'SUAS_FINGERPRINT_KEY: keys the VA identity and licence fingerprints',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });
    const fingerprintEnv: Env = {
      SUAS_FINGERPRINT_KEY: fingerprintKeySecret.secretValue.unsafeUnwrap(),
      SUAS_FINGERPRINT_KEY_ID: FINGERPRINT_KEY_ID,
    };
    // Bearer token for the reader's read endpoint; the same value is set on the reader.
    const scryApiTokenSecret = new secretsmanager.Secret(this, 'ScryApiTokenSecret', {
      description: 'SUAS_SCRY_API_TOKEN: bearer token for the licence reader (job worker only)',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // -------------------------------------------------------------------- api
    const code = suasLambdaCode();

    // R11.5 (D-052): the tenant-id:user-id pairs STAGING admits, R11.7: the mailbox whose
    // plus addresses may be fixture addresses, and suas #305: the Resend sender. The operator
    // creates these String parameters before the first deploy (infra/README.md). CloudFormation resolves them at each deploy,
    // so no function reads SSM at run time and none gets an SSM grant.
    const fixtureParameter = (name: string): string =>
      ssm.StringParameter.valueForStringParameter(this, fixtureParameterName(config.name, name));

    // Settings every function needs for configuration to validate (src/config/schema.ts).
    const baseEnv: Env = {
      SUAS_ENV: config.suasEnv,
      SUAS_SPEC_VERSION: SPEC_VERSION,
      SUAS_RELEASE_MANIFEST: RELEASE_MANIFEST,
      SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
      SUAS_SESSION_SECRET: sessionSecret.secretValue.unsafeUnwrap(),
      SUAS_AWS_REGION: REGION,
      SUAS_BROWSER_AUTH_MODE: 'disabled',
      SUAS_EMAIL_MODE: 'disabled',
      SUAS_SMS_MODE: 'sink',
      SUAS_TRANSPORTATION_ADAPTER_MODE: 'fake',
      SUAS_SHELTER_ADAPTER_MODE: 'fake',
      SUAS_FOOD_ADAPTER_MODE: 'fake',
      SUAS_PEER_SUPPORT_ADAPTER_MODE: 'manual',
      SUAS_SUPPORT_SIGNAL_MODE: 'fixture',
      SUAS_SAFETY_COPY_MODE: config.safetyCopyMode,
      SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
      // R10.1 is a proposal and the reader's egress (R9.2, owner question 8) is not decided.
      SUAS_LICENCE_READER_MODE: 'disabled',
      SUAS_LOG_LEVEL: 'info',
      SUAS_BUILD_COMMIT: config.buildCommit,
      SUAS_BUILD_TIMESTAMP: config.buildTimestamp,
      DATABASE_POOL_MAX: '3',
      DATABASE_SSL_MODE: 'verify',
      SUAS_MIGRATIONS_MODE: 'off',
      SUAS_STAGING_FIXTURE_REGISTRY: fixtureParameter('fixture-registry'),
      SUAS_STAGING_FIXTURE_MAILBOX: fixtureParameter('fixture-mailbox'),
      ...directDatabase,
    };

    const functionLogGroups = new Map<string, logs.LogGroup>();
    const newFunction = (
      fnId: string,
      options: {
        readonly handler: string;
        readonly env: Env;
        readonly sg: ec2.ISecurityGroup;
        readonly memory: number;
        readonly timeout: Duration;
        readonly layers?: lambda.ILayerVersion[];
        readonly reservedConcurrency?: number;
      },
    ): lambda.Function => {
      const logGroup = new logs.LogGroup(this, `${fnId}Logs`, {
        retention: LOG_RETENTION,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      // No managed policies: the role can write to its own log group and manage the ENIs
      // Lambda needs inside the VPC, and nothing else until a grant below adds it.
      const role = new iam.Role(this, `${fnId}Role`, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      logGroup.grantWrite(role);
      functionLogGroups.set(fnId, logGroup);
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'ec2:CreateNetworkInterface',
            'ec2:DescribeNetworkInterfaces',
            'ec2:DescribeSubnets',
            'ec2:DeleteNetworkInterface',
            'ec2:AssignPrivateIpAddresses',
            'ec2:UnassignPrivateIpAddresses',
          ],
          // These actions cannot be scoped to a resource.
          resources: ['*'],
        }),
      );
      return new lambda.Function(this, fnId, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        code,
        handler: options.handler,
        memorySize: options.memory,
        timeout: options.timeout,
        role,
        logGroup,
        vpc,
        vpcSubnets: isolated,
        securityGroups: [options.sg],
        environment: options.env,
        ...(options.layers !== undefined ? { layers: options.layers } : {}),
        ...(options.reservedConcurrency !== undefined
          ? { reservedConcurrentExecutions: options.reservedConcurrency }
          : {}),
      });
    };

    // suas #305: Resend from outside the VPC. The API and worker hand it rendered messages.
    const emailRelay = new EmailRelay(this, 'EmailRelay', {
      code,
      logRetention: LOG_RETENTION,
      fromAddress: fixtureParameter('email-from'),
      fixtureMailbox: fixtureParameter('fixture-mailbox'),
    });
    const viaEmailRelay: Env = {
      SUAS_EMAIL_MODE: 'resend',
      SUAS_EMAIL_RELAY_FUNCTION: emailRelay.function.functionName,
    };

    const webAdapterLayer = lambda.LayerVersion.fromLayerVersionArn(
      this,
      'WebAdapterLayer',
      `arn:aws:lambda:${REGION}:${WEB_ADAPTER_LAYER_PUBLISHER}:layer:LambdaAdapterLayerArm64:${String(config.webAdapterLayerVersion)}`,
    );

    const apiFunction = newFunction('ApiFunction', {
      handler: 'run.sh',
      sg: lambdaSg,
      memory: 512,
      timeout: Duration.seconds(30),
      layers: [webAdapterLayer],
      reservedConcurrency: API_RESERVED_CONCURRENCY,
      env: {
        ...baseEnv,
        SUAS_MIGRATIONS_MODE: 'validate',
        SUAS_HTTP_HOST: '0.0.0.0',
        SUAS_HTTP_PORT: API_PORT,
        SUAS_BROWSER_AUTH_MODE: 'email_otp',
        SUAS_BROWSER_TENANT_ID: config.browserTenantId,
        // R11.3 (D-038): the v1 web client's origin, which calls this API with Bearer. A
        // non-empty allowlist makes the /app session cookie SameSite=None (src/http/routes/ui.ts).
        SUAS_CORS_ALLOWED_ORIGINS: `https://${config.webHostname}`,
        ...viaEmailRelay,
        // R2.15 is not approved. The Bedrock adapter is not selected.
        SUAS_MODEL_INFERENCE_MODE: 'disabled',
        SUAS_OBJECT_STORAGE_MODE: 's3',
        SUAS_S3_BUCKET: assetsBucket.bucketName,
        // No ID-scan provider is chosen (plan §8 item 2) and fake is refused on STAGING (D-052).
        // The request gate does not read this: VA confirmation or self-attestation opens it
        // (VETERAN_VERIFICATION.md §21, released in 0.10.0).
        SUAS_ID_VERIFICATION_MODE: 'disabled',
        // R6.12 is not accepted. Chat still works over REST. The push adapter is not selected.
        SUAS_CHAT_PUSH_MODE: 'disabled',
        ...fingerprintEnv,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        AWS_LWA_PORT: API_PORT,
        AWS_LWA_READINESS_CHECK_PATH: '/api/v0/health',
        AWS_LWA_ASYNC_INIT: 'true',
      },
    });

    const jobWorkerFunction = newFunction('JobWorkerFunction', {
      handler: 'job-worker.handler',
      sg: lambdaSg,
      memory: 512,
      timeout: Duration.minutes(2),
      reservedConcurrency: JOB_WORKER_RESERVED_CONCURRENCY,
      env: {
        ...baseEnv,
        ...viaEmailRelay,
        // The licence read job reads the images and deletes them when it settles a review.
        SUAS_OBJECT_STORAGE_MODE: 's3',
        SUAS_S3_BUCKET: assetsBucket.bucketName,
        ...fingerprintEnv,
        SUAS_SCRY_API_TOKEN: scryApiTokenSecret.secretValue.unsafeUnwrap(),
        // SUAS_SCRY_BASE_URL stays unset: no route to the reader's host is built until the
        // owner decides its egress (R9.2). The worker reaches only the VPC endpoints.
      },
    });

    const migrateFunction = newFunction('MigrateFunction', {
      handler: 'migrate.handler',
      sg: migrateSg,
      memory: 512,
      timeout: Duration.minutes(5),
      reservedConcurrency: MIGRATE_RESERVED_CONCURRENCY,
      env: {
        ...baseEnv,
        SUAS_MIGRATIONS_MODE: 'apply',
        DATABASE_POOL_MAX: '1',
      },
    });

    // ------------------------------------------------------- IAM (least privilege)
    // Email: invoke the email relay and nothing else. No bedrock:InvokeModel: inference is disabled.
    emailRelay.function.grantInvoke(apiFunction);
    emailRelay.function.grantInvoke(jobWorkerFunction);

    // VA_CONFIRMATION_FLOW W9 item 4 (R9.2 option (b)): VA sandbox calls go through the
    // outside-VPC verify function, built only with `-c vaSandbox=true`. Off, the API keeps
    // SUAS_VA_CONFIRMATION_MODE=disabled. Only the API may invoke it, over the Lambda endpoint.
    let vaVerify: VaVerify | undefined;
    if (config.vaSandbox) {
      vaVerify = new VaVerify(this, 'VaVerify', {
        code,
        logRetention: LOG_RETENTION,
        suasEnv: config.suasEnv,
      });
      apiFunction.addEnvironment('SUAS_VA_CONFIRMATION_MODE', 'sandbox');
      apiFunction.addEnvironment(
        'SUAS_VA_CONFIRMATION_RELAY_FUNCTION',
        vaVerify.function.functionName,
      );
      vaVerify.function.grantInvoke(apiFunction);
      new CfnOutput(this, 'VaVerifySecretName', {
        description: 'Put the LLC-owned VA sandbox key here by hand (see infra/README.md).',
        value: vaVerify.secret.secretName,
      });
    }
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [assetsBucket.arnForObjects('*')],
      }),
    );
    // Without list permission, S3 answers AccessDenied instead of NoSuchKey for a missing key,
    // and the storage adapter maps only NoSuchKey to "not found".
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [assetsBucket.bucketArn],
      }),
    );
    // The job worker touches licence images only: read and delete under the one prefix.
    jobWorkerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:DeleteObject'],
        resources: [assetsBucket.arnForObjects(`${LICENCE_REVIEWS_PREFIX}*`)],
      }),
    );
    // A missing image must read as 404 (PHOTOS_GONE), not 403 (SCRY_LICENCE_FALLBACK.md L4.7).
    // AWS documents that only for an unconditioned ListBucket, so the grant has no s3:prefix
    // condition. Listing shows key names only, which are opaque ids with no personal data.
    jobWorkerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['s3:ListBucket'],
        resources: [assetsBucket.bucketArn],
      }),
    );
    // ---------------------------------------------------- certificate and domains
    const certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: config.apiHostname,
      validation: acm.CertificateValidation.fromDns(zone),
    });
    const regionalDomain = (domainId: string, domainName: string): apigw.DomainName =>
      new apigw.DomainName(this, domainId, {
        domainName,
        certificate,
        securityPolicy: apigw.SecurityPolicy.TLS_1_2,
      });
    const aliasTo = (recordId: string, hostname: string, domain: apigw.DomainName): void => {
      new route53.ARecord(this, recordId, {
        zone,
        recordName: hostname,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.ApiGatewayv2DomainProperties(
            domain.regionalDomainName,
            domain.regionalHostedZoneId,
          ),
        ),
      });
    };

    // HTTP API: every route goes to the API function. No request or response bodies, paths,
    // query strings or client addresses are logged; the access log is a fixed metadata record.
    const apiDomain = regionalDomain('ApiDomain', config.apiHostname);
    const httpApi = new apigw.HttpApi(this, 'HttpApi', {
      apiName: `suas-${config.name}-api`,
      createDefaultStage: false,
      disableExecuteApiEndpoint: true,
      defaultIntegration: new apigwIntegrations.HttpLambdaIntegration(
        'ApiIntegration',
        apiFunction,
        {
          // HTTP API integrations cannot wait longer than 29 seconds.
          timeout: Duration.seconds(29),
        },
      ),
    });
    const accessLogs = new logs.LogGroup(this, 'HttpApiAccessLogs', {
      retention: LOG_RETENTION,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    new apigw.HttpStage(this, 'HttpApiStage', {
      httpApi,
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
      domainMapping: { domainName: apiDomain },
      accessLogSettings: {
        destination: new apigw.LogGroupLogDestination(accessLogs),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            routeKey: '$context.routeKey',
            status: '$context.status',
            responseLatency: '$context.responseLatency',
            integrationStatus: '$context.integration.status',
          }),
        ),
      },
    });
    aliasTo('ApiAlias', config.apiHostname, apiDomain);

    // ------------------------------------------------------------------- jobs
    // One pass of the job worker each minute (outbox drain plus request widening).
    const jobWorkerSchedule = new scheduler.Schedule(this, 'JobWorkerSchedule', {
      description: 'Runs one pass of the job worker: outbox drain and request widening',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
      target: new schedulerTargets.LambdaInvoke(jobWorkerFunction, {
        input: scheduler.ScheduleTargetInput.fromObject({}),
        retryAttempts: 0,
      }),
    });
    if (deploymentPipelineEnabled(this)) {
      applyDeploymentMode(this, {
        api: apiFunction,
        worker: jobWorkerFunction,
        schedule: jobWorkerSchedule,
        databaseIdentifier: database.instanceIdentifier,
      });
    }

    // ------------------------------------------------------------------ alarms
    // Count the failure messages the code logs and alarm on any in five minutes. There is no
    // notification target yet: the alarm only shows in the console until one is chosen.
    //   job_failed, sweep_failed: src/jobs/worker.ts (job worker)
    //   chat push failed:         src/chat/send.ts (API, through pino)
    //   relay_ambiguous_ack, relay_unavailable: the email_send outcome (src/notifications/
    //   channels.ts, both) when a relay invoke's answer is lost or the invoke is refused, as when
    //   the one Lambda endpoint zone is down (R14.1). Terms, because the Node runtime prefixes
    //   the job worker's lines, so a JSON selector would not match them.
    const failureTerms = ['job_failed', 'sweep_failed', 'chat push failed'];
    const relayFailure = logs.FilterPattern.anyTerm('relay_ambiguous_ack', 'relay_unavailable');
    const alarmOnLogMatches = (
      logGroup: logs.LogGroup,
      id: string,
      metricName: string,
      filterPattern: logs.IFilterPattern,
      description: string,
    ): void => {
      logGroup.addMetricFilter(`${id}Filter`, {
        filterPattern,
        metricNamespace: `Suas/${config.name}`,
        metricName,
        metricValue: '1',
        defaultValue: 0,
      });
      new cloudwatch.Alarm(this, `${id}Alarm`, {
        alarmDescription: `${description} No notification target yet.`,
        metric: new cloudwatch.Metric({
          namespace: `Suas/${config.name}`,
          metricName,
          statistic: 'Sum',
          period: Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    };
    for (const [fnId, label] of [
      ['ApiFunction', 'Api'],
      ['JobWorkerFunction', 'JobWorker'],
    ] as const) {
      const logGroup = functionLogGroups.get(fnId);
      if (logGroup === undefined) throw new Error(`No log group recorded for ${fnId}.`);
      alarmOnLogMatches(
        logGroup,
        `${label}Failure`,
        `${label}FailureMessages`,
        logs.FilterPattern.anyTerm(...failureTerms),
        `${label}: the code logged ${failureTerms.join(', ')}.`,
      );
      alarmOnLogMatches(
        logGroup,
        `${label}RelayFailure`,
        `${label}RelayFailures`,
        relayFailure,
        `${label}: an email relay invoke was refused (relay_unavailable) or its answer lost (relay_ambiguous_ack).`,
      );
    }

    // The secret is deployed with a placeholder, so until the operator stores the key every call
    // is refused this way. Terms, not a JSON selector: the Node runtime prefixes these lines too.
    if (vaVerify !== undefined) {
      alarmOnLogMatches(
        vaVerify.logGroup,
        'VaVerifyNotConfigured',
        'VaVerifyNotConfigured',
        logs.FilterPattern.allTerms('va_verify_refused', 'not_configured'),
        'VaVerify: a call was refused because the secret holds no valid VA sandbox key or could not be read (va_verify_refused, not_configured).',
      );
    }

    // Reserved concurrency holds connections to 52; this shows when something else (a manual
    // session, a leak, a raised cap) pushes them towards max_connections. No target yet either.
    new cloudwatch.Alarm(this, 'DatabaseConnectionsAlarm', {
      alarmDescription: `Database connections reached ${String(DB_CONNECTIONS_ALARM)} of max_connections ${String(DB_MAX_CONNECTIONS)}; the reserved-concurrency budget is 52. No notification target yet.`,
      metric: database.metricDatabaseConnections({
        statistic: 'Maximum',
        period: Duration.minutes(5),
      }),
      threshold: DB_CONNECTIONS_ALARM,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new CfnOutput(this, 'ApiUrl', { value: `https://${config.apiHostname}` });
    new CfnOutput(this, 'MigrateFunctionName', {
      description: 'Invoke once after each deploy that adds migrations.',
      value: migrateFunction.functionName,
    });
    new CfnOutput(this, 'DatabaseSecretName', { value: dbSecret.secretName });
    new CfnOutput(this, 'EmailRelaySecretName', {
      description: 'Put the Resend API key here by hand (see infra/README.md).',
      value: emailRelay.secret.secretName,
    });
  }
}
