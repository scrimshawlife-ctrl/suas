/**
 * The VA verify function (VA_CONFIRMATION_FLOW W9 item 4, R9.2 option (b), released in 0.10.0):
 * the one function that reaches the VA sandbox. The staging VPC has no internet egress, so it runs
 * outside the VPC, has no database access, and its role can read only its own secret. The API
 * invokes it with one projection (src/aws/va-verify-lambda.ts).
 *
 * The secret is created here with a placeholder. The operator puts an LLC-owned VA sandbox key
 * into it by hand (see README); nothing in the template carries it.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface VaVerifyProps {
  readonly code: lambda.Code;
  readonly logRetention: logs.RetentionDays;
  /** SUAS_ENV: the function refuses outside STAGING. */
  readonly suasEnv: 'STAGING';
}

export class VaVerify extends Construct {
  readonly function: lambda.Function;
  readonly secret: secretsmanager.Secret;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: VaVerifyProps) {
    super(scope, id);

    // JSON `{"SUAS_VA_CONFIRMATION_API_KEY": "..."}`. The generated value fills an unused key,
    // so the function answers UNAVAILABLE / CONFIGURATION_INVALID until the key is stored.
    this.secret = new secretsmanager.Secret(this, 'ApiKey', {
      description:
        'VA sandbox key for the VA verify function: {"SUAS_VA_CONFIRMATION_API_KEY"}. Set by hand.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ SUAS_VA_CONFIRMATION_API_KEY: '' }),
        generateStringKey: 'placeholder',
        excludePunctuation: true,
      },
    });

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // No managed policies and no VPC permissions: the role writes its log group and reads
    // its one secret, nothing else.
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.logGroup.grantWrite(role);
    // The current version only: the function asks for AWSCURRENT by name, so a version that
    // put-secret-value replaced cannot be read with this role.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [this.secret.secretArn],
        conditions: { StringEquals: { 'secretsmanager:VersionStage': 'AWSCURRENT' } },
      }),
    );

    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: props.code,
      handler: 'va-verify.handler',
      memorySize: 256,
      // Above the 10 s VA request bound plus the secret read, below the API's 18 s invoke bound.
      timeout: Duration.seconds(15),
      role,
      logGroup: this.logGroup,
      environment: {
        SUAS_ENV: props.suasEnv,
        SUAS_VA_CONFIRMATION_SECRET_ID: this.secret.secretArn,
      },
    });
  }
}
