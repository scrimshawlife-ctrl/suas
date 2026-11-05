/**
 * The STAGING backend (synthetic data only): network, database, the API, the WebSocket
 * API, the scheduled job worker, the migrate function, and the assets bucket.
 *
 * Design rules (user decisions of 2026-11-05):
 *  - The VPC has isolated subnets only. There is no NAT gateway and no internet gateway
 *    route. Lambdas reach AWS through a gateway endpoint (S3) and interface endpoints for
 *    the services the code calls, and nothing else.
 *  - Lambdas reach Postgres through RDS Proxy with TLS. Only the migrate function connects
 *    to the instance directly, because the migrator holds a session advisory lock.
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
import type { Construct } from 'constructs';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../../src/release/pins.js';
import { REGION, type EnvironmentConfig } from './config.js';
import { RDS_CA_BUNDLE_FILE, suasLambdaCode } from './lambda-code.js';

export interface BackendStackProps extends StackProps {
  readonly config: EnvironmentConfig;
  readonly zone: route53.IHostedZone;
  /** SES domain identity ARN (from the DNS stack). */
  readonly sesIdentityArn: string;
}

const DB_NAME = 'suas';
const DB_PORT = 5432;
const API_PORT = '8080';
const LOG_RETENTION = logs.RetentionDays.ONE_MONTH;
/** The AWS-published Lambda Web Adapter layer lives in an AWS-owned account. */
const WEB_ADAPTER_LAYER_PUBLISHER = '753240598075';

type Env = Record<string, string>;

export class BackendStack extends Stack {
  constructor(scope: Construct, id: string, props: BackendStackProps) {
    super(scope, id, props);
    const { config, zone } = props;
    const isolated: ec2.SubnetSelection = { subnetType: ec2.SubnetType.PRIVATE_ISOLATED };

    // ---------------------------------------------------------------- network
    const zones =
      config.availabilityZones.length > 0
        ? [...config.availabilityZones]
        : [Fn.select(0, Fn.getAzs(REGION)), Fn.select(1, Fn.getAzs(REGION))];
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      availabilityZones: zones,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const lambdaSg = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc,
      description: 'API, WebSocket and job worker functions',
      allowAllOutbound: false,
    });
    const migrateSg = new ec2.SecurityGroup(this, 'MigrateSg', {
      vpc,
      description: 'Migrate function (connects to the instance directly)',
      allowAllOutbound: false,
    });
    const proxySg = new ec2.SecurityGroup(this, 'ProxySg', {
      vpc,
      description: 'RDS Proxy',
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

    // Lambda -> Proxy -> RDS on 5432, and migrate -> RDS on 5432. Nothing else.
    proxySg.connections.allowFrom(lambdaSg, ec2.Port.tcp(DB_PORT), 'Lambda to RDS Proxy');
    lambdaSg.connections.allowTo(proxySg, ec2.Port.tcp(DB_PORT), 'Lambda to RDS Proxy');
    dbSg.connections.allowFrom(proxySg, ec2.Port.tcp(DB_PORT), 'RDS Proxy to RDS');
    proxySg.connections.allowTo(dbSg, ec2.Port.tcp(DB_PORT), 'RDS Proxy to RDS');
    dbSg.connections.allowFrom(migrateSg, ec2.Port.tcp(DB_PORT), 'Migrate to RDS');
    migrateSg.connections.allowTo(dbSg, ec2.Port.tcp(DB_PORT), 'Migrate to RDS');
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
    const interfaceEndpoints: ReadonlyArray<readonly [string, ec2.InterfaceVpcEndpointAwsService]> =
      [
        ['BedrockRuntimeEndpoint', ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME],
        ['SesApiEndpoint', ec2.InterfaceVpcEndpointAwsService.EMAIL],
        ['ExecuteApiEndpoint', ec2.InterfaceVpcEndpointAwsService.APIGATEWAY],
      ];
    for (const [endpointId, service] of interfaceEndpoints) {
      vpc.addInterfaceEndpoint(endpointId, {
        service,
        subnets: isolated,
        securityGroups: [endpointSg],
        // Only the Lambda security group may reach the endpoints, not the whole VPC CIDR.
        open: false,
        privateDnsEnabled: true,
      });
    }

    // --------------------------------------------------------------- database
    const dbParameters = new rds.ParameterGroup(this, 'DatabaseParameters', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_17 }),
      parameters: { 'rds.force_ssl': '1' },
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

    const proxy = database.addProxy('Proxy', {
      dbProxyName: `suas-${config.name}`,
      secrets: [dbSecret],
      vpc,
      vpcSubnets: isolated,
      securityGroups: [proxySg],
      requireTLS: true,
      iamAuth: false,
    });

    const dbUser = dbSecret.secretValueFromJson('username').unsafeUnwrap();
    const dbPassword = dbSecret.secretValueFromJson('password').unsafeUnwrap();
    const databaseUrl = (host: string): string =>
      Fn.join('', [
        'postgresql://',
        dbUser,
        ':',
        dbPassword,
        '@',
        host,
        `:${String(DB_PORT)}/${DB_NAME}`,
      ]);

    // ---------------------------------------------------------------- storage
    const assetsBucket = new s3.Bucket(this, 'AssetsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      description: 'SUAS_SESSION_SECRET: keys challenge and session credential hashing',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
    });

    // -------------------------------------------------------------------- api
    const code = suasLambdaCode();

    const wsApi = new apigw.WebSocketApi(this, 'WebSocketApi', {
      apiName: `suas-${config.name}-chat`,
    });
    const wsStageName = config.name;
    // Management (@connections) endpoint, which the push adapter posts to.
    const wsManagementEndpoint = Fn.join('', [
      'https://',
      wsApi.apiId,
      `.execute-api.${REGION}.${this.urlSuffix}/`,
      wsStageName,
    ]);

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
      SUAS_LOG_LEVEL: 'info',
      SUAS_BUILD_COMMIT: config.buildCommit,
      SUAS_BUILD_TIMESTAMP: config.buildTimestamp,
      DATABASE_POOL_MAX: '3',
      DATABASE_SSL_MODE: 'verify',
      SUAS_MIGRATIONS_MODE: 'off',
    };
    const viaProxy: Env = { DATABASE_URL: databaseUrl(proxy.endpoint) };

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
      });
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
      env: {
        ...baseEnv,
        ...viaProxy,
        SUAS_MIGRATIONS_MODE: 'validate',
        SUAS_HTTP_HOST: '0.0.0.0',
        SUAS_HTTP_PORT: API_PORT,
        SUAS_BROWSER_AUTH_MODE: 'email_otp',
        SUAS_BROWSER_TENANT_ID: config.browserTenantId,
        // SUAS_CORS_ALLOWED_ORIGINS stays unset, which is an empty allowlist.
        // Lambda rejects an empty string, and unset parses as no origins. The
        // Worker origin serves /app same-origin (suasqrf.com). A separate
        // frontend domain and the cross-site cookie question are unsettled, so
        // do not list the staging web hostname.
        SUAS_EMAIL_MODE: 'ses',
        SUAS_EMAIL_FROM: config.emailFrom,
        SUAS_MODEL_INFERENCE_MODE: 'bedrock',
        SUAS_BEDROCK_MODEL_ID: config.bedrockModelId,
        SUAS_OBJECT_STORAGE_MODE: 's3',
        SUAS_S3_BUCKET: assetsBucket.bucketName,
        // No identity-check provider is chosen (plan §8 item 2). Fake ID verification
        // is refused on STAGING (D-052), so the gate stays disabled.
        SUAS_ID_VERIFICATION_MODE: 'disabled',
        SUAS_CHAT_PUSH_MODE: 'apigw',
        SUAS_CHAT_WS_ENDPOINT: wsManagementEndpoint,
        SUAS_CHAT_WS_PUBLIC_URL: `wss://${config.wsHostname}`,
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/bootstrap',
        AWS_LWA_PORT: API_PORT,
        AWS_LWA_READINESS_CHECK_PATH: '/api/v0/health',
        AWS_LWA_ASYNC_INIT: 'true',
      },
    });

    const webSocketFunction = newFunction('WebSocketFunction', {
      handler: 'websocket.handler',
      sg: lambdaSg,
      memory: 256,
      timeout: Duration.seconds(10),
      env: {
        ...baseEnv,
        ...viaProxy,
        SUAS_CHAT_PUSH_MODE: 'apigw',
        SUAS_CHAT_WS_ENDPOINT: wsManagementEndpoint,
      },
    });

    const jobWorkerFunction = newFunction('JobWorkerFunction', {
      handler: 'job-worker.handler',
      sg: lambdaSg,
      memory: 512,
      timeout: Duration.minutes(2),
      env: {
        ...baseEnv,
        ...viaProxy,
        SUAS_EMAIL_MODE: 'ses',
        SUAS_EMAIL_FROM: config.emailFrom,
      },
    });

    const migrateFunction = newFunction('MigrateFunction', {
      handler: 'migrate.handler',
      sg: migrateSg,
      memory: 512,
      timeout: Duration.minutes(5),
      env: {
        ...baseEnv,
        DATABASE_URL: databaseUrl(database.dbInstanceEndpointAddress),
        DATABASE_SSL_CA_FILE: `/var/task/${RDS_CA_BUNDLE_FILE}`,
        SUAS_MIGRATIONS_MODE: 'apply',
        DATABASE_POOL_MAX: '1',
      },
    });

    // ------------------------------------------------------- IAM (least privilege)
    // SES: send from the one domain identity. Bedrock: invoke the one chosen model.
    const sendEmail = new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: [props.sesIdentityArn],
    });
    apiFunction.addToRolePolicy(sendEmail);
    jobWorkerFunction.addToRolePolicy(sendEmail);
    apiFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: this.bedrockModelArns(config.bedrockModelId),
      }),
    );
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
    wsApi.grantManageConnections(apiFunction);

    // ---------------------------------------------------- certificate and domains
    const certificate = new acm.Certificate(this, 'ApiCertificate', {
      domainName: config.apiHostname,
      subjectAlternativeNames: [config.wsHostname],
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

    // WebSocket API: $connect (ticket in the query string), $disconnect and $default all go to
    // the WebSocket function. No access log is kept, because it could capture the ticket.
    const wsIntegration = (name: string): apigwIntegrations.WebSocketLambdaIntegration =>
      new apigwIntegrations.WebSocketLambdaIntegration(name, webSocketFunction);
    wsApi.addRoute('$connect', { integration: wsIntegration('WsConnectIntegration') });
    wsApi.addRoute('$disconnect', { integration: wsIntegration('WsDisconnectIntegration') });
    wsApi.addRoute('$default', { integration: wsIntegration('WsDefaultIntegration') });
    const wsDomain = regionalDomain('WebSocketDomain', config.wsHostname);
    new apigw.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi: wsApi,
      stageName: wsStageName,
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
      // Root mapping: the public URL needs no stage path.
      domainMapping: { domainName: wsDomain },
    });
    aliasTo('WebSocketAlias', config.wsHostname, wsDomain);

    // ------------------------------------------------------------------- jobs
    // One pass of the job worker each minute (outbox drain plus request widening).
    new scheduler.Schedule(this, 'JobWorkerSchedule', {
      description: 'Runs one pass of the job worker: outbox drain and request widening',
      schedule: scheduler.ScheduleExpression.rate(Duration.minutes(1)),
      target: new schedulerTargets.LambdaInvoke(jobWorkerFunction, {
        input: scheduler.ScheduleTargetInput.fromObject({}),
        retryAttempts: 0,
      }),
    });

    // ------------------------------------------------------------------ alarms
    // Count the failure messages the code logs and alarm on any in five minutes. There is no
    // notification target yet: the alarm only shows in the console until one is chosen.
    //   job_failed, sweep_failed: src/jobs/worker.ts (job worker)
    //   chat push failed:         src/chat/send.ts (API, through pino)
    const failureTerms = ['job_failed', 'sweep_failed', 'chat push failed'];
    for (const [fnId, label] of [
      ['ApiFunction', 'Api'],
      ['JobWorkerFunction', 'JobWorker'],
    ] as const) {
      const logGroup = functionLogGroups.get(fnId);
      if (logGroup === undefined) throw new Error(`No log group recorded for ${fnId}.`);
      const metricName = `${label}FailureMessages`;
      logGroup.addMetricFilter(`${label}FailureFilter`, {
        filterPattern: logs.FilterPattern.anyTerm(...failureTerms),
        metricNamespace: `Suas/${config.name}`,
        metricName,
        metricValue: '1',
        defaultValue: 0,
      });
      new cloudwatch.Alarm(this, `${label}FailureAlarm`, {
        alarmDescription: `${label}: the code logged ${failureTerms.join(', ')}. No notification target yet.`,
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
    }

    new CfnOutput(this, 'ApiUrl', { value: `https://${config.apiHostname}` });
    new CfnOutput(this, 'WebSocketUrl', { value: `wss://${config.wsHostname}` });
    new CfnOutput(this, 'MigrateFunctionName', {
      description: 'Invoke once after each deploy that adds migrations.',
      value: migrateFunction.functionName,
    });
    new CfnOutput(this, 'DatabaseSecretName', { value: dbSecret.secretName });
  }

  /**
   * IAM resources for one model. A model id with a geography prefix (us., eu., global., ...)
   * is an inference profile: invoking it needs the profile in this account and the underlying
   * foundation model in whichever region the profile routes to, so the region is the only
   * wildcard. A plain id is that one foundation model in this region.
   */
  private bedrockModelArns(modelId: string): string[] {
    const profile = /^(us|eu|apac|global|ca|jp|au)\.(.+)$/.exec(modelId);
    if (profile === null || profile[2] === undefined) {
      return [`arn:${this.partition}:bedrock:${REGION}::foundation-model/${modelId}`];
    }
    return [
      `arn:${this.partition}:bedrock:${REGION}:${this.account}:inference-profile/${modelId}`,
      `arn:${this.partition}:bedrock:*::foundation-model/${profile[2]}`,
    ];
  }
}
