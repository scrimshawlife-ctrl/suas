/**
 * The SMTP relay (suas-specs #75 R11.2, proposal): the one function that reaches
 * smtp.gmail.com. The staging VPC has no internet egress, so it runs outside the VPC, has
 * no database access, and its role can read only its own secret. The API and job worker
 * invoke it with one rendered message (src/aws/smtp-relay-lambda.ts).
 *
 * The secret is created here with a placeholder. The operator puts the Gmail address and
 * app password into it by hand (see README); nothing in the template carries them.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface SmtpRelayProps {
  readonly code: lambda.Code;
  readonly logRetention: logs.RetentionDays;
  /** SUAS_STAGING_FIXTURE_MAILBOX: the relay's own copy of the last-hop allowlist (r263 F2). */
  readonly fixtureMailbox: string;
}

export class SmtpRelay extends Construct {
  readonly function: lambda.Function;
  readonly secret: secretsmanager.Secret;

  constructor(scope: Construct, id: string, props: SmtpRelayProps) {
    super(scope, id);

    // JSON with the two R11.2 settings. The generated value is a placeholder: the relay
    // answers "retryable" until the operator stores a real address and app password.
    this.secret = new secretsmanager.Secret(this, 'Credentials', {
      description: 'Gmail SMTP sender: {"SUAS_SMTP_USER", "SUAS_SMTP_APP_PASSWORD"}. Set by hand.',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ SUAS_SMTP_USER: '' }),
        generateStringKey: 'SUAS_SMTP_APP_PASSWORD',
        excludePunctuation: true,
      },
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // No managed policies and no VPC permissions: the role writes its log group and reads
    // its one secret, nothing else.
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    logGroup.grantWrite(role);
    this.secret.grantRead(role);

    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: props.code,
      handler: 'smtp-relay.handler',
      memorySize: 256,
      // Above the relay's own 20 s SMTP session bound, below the callers' 28 s invoke bound.
      timeout: Duration.seconds(25),
      role,
      logGroup,
      environment: {
        SUAS_SMTP_SECRET_ID: this.secret.secretArn,
        SUAS_STAGING_FIXTURE_MAILBOX: props.fixtureMailbox,
      },
    });
  }
}
