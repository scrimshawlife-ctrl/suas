/**
 * The inference relay (R17.3, contributor proposal, not released): the one function that calls
 * Bedrock. The staging VPC has no route to Bedrock, so it runs outside the VPC, has no database
 * access and no secret, and its role may call one inference profile and apply one guardrail.
 * The API invokes it with one model turn (src/aws/inference-relay-lambda.ts).
 */

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/** The geographic prefix of a US cross-region inference profile id (R17.2, proposal). */
const US_PROFILE_PREFIX = 'us.';

export interface InferenceRelayProps {
  readonly code: lambda.Code;
  readonly logRetention: logs.RetentionDays;
  /** SUAS_ENV: the function refuses outside STAGING. */
  readonly suasEnv: 'STAGING';
  /** SUAS_AWS_REGION: the source region the inference profile is called in. */
  readonly region: string;
  /** SUAS_BEDROCK_MODEL_ID: a `us.anthropic.` inference profile id. */
  readonly modelId: string;
  readonly guardrailId: string;
  readonly guardrailVersion: string;
  readonly guardrailArn: string;
}

/** `us.anthropic.x` -> `anthropic.x`, the foundation model the US profile routes to. */
export function foundationModelIdOf(profileId: string): string {
  if (!profileId.startsWith(US_PROFILE_PREFIX)) {
    throw new Error(
      `Inference profile id must start with "${US_PROFILE_PREFIX}"; got "${profileId}".`,
    );
  }
  return profileId.slice(US_PROFILE_PREFIX.length);
}

export class InferenceRelay extends Construct {
  readonly function: lambda.Function;
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: InferenceRelayProps) {
    super(scope, id);
    const stack = Stack.of(this);

    this.logGroup = new logs.LogGroup(this, 'Logs', {
      retention: props.logRetention,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    // No managed policies and no VPC permissions: the role writes its log group, calls the one
    // profile and its foundation model, and applies the one guardrail, nothing else.
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.logGroup.grantWrite(role);

    // Converse is authorized as InvokeModel. A US profile routes to us-east-1, us-east-2 and
    // us-west-2, so the foundation model is any region, but only when reached through this profile.
    const profileArn = stack.formatArn({
      service: 'bedrock',
      resource: 'inference-profile',
      resourceName: props.modelId,
    });
    role.addToPolicy(
      new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [profileArn] }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          stack.formatArn({
            service: 'bedrock',
            region: '*',
            account: '',
            resource: 'foundation-model',
            resourceName: foundationModelIdOf(props.modelId),
          }),
        ],
        conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profileArn } },
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:ApplyGuardrail'],
        resources: [props.guardrailArn],
      }),
    );

    this.function = new lambda.Function(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      code: props.code,
      handler: 'inference-relay.handler',
      memorySize: 512,
      // Above the longest call it makes (extraction, 24 s, retries included) plus a cold start,
      // below the API's 28 s invoke abort, so the API hears the relay's answer or its timeout.
      timeout: Duration.seconds(27),
      role,
      logGroup: this.logGroup,
      environment: {
        SUAS_ENV: props.suasEnv,
        SUAS_AWS_REGION: props.region,
        SUAS_BEDROCK_MODEL_ID: props.modelId,
        SUAS_BEDROCK_GUARDRAIL_ID: props.guardrailId,
        SUAS_BEDROCK_GUARDRAIL_VERSION: props.guardrailVersion,
      },
    });
  }
}
