/**
 * The inference relay (R17.3, contributor proposal, not released): the one function that calls
 * Bedrock. The staging VPC has no route to Bedrock, so it runs outside the VPC, has no database
 * access and no secret, and its role may call one base model in its region and apply one guardrail.
 * The API invokes it with one model turn (src/aws/inference-relay-lambda.ts).
 */

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface InferenceRelayProps {
  readonly code: lambda.Code;
  readonly logRetention: logs.RetentionDays;
  /** SUAS_ENV: the function refuses outside STAGING. */
  readonly suasEnv: 'STAGING';
  /** SUAS_AWS_REGION: the stack's region, where the model is invoked on demand. */
  readonly region: string;
  /** SUAS_BEDROCK_MODEL_ID: an on-demand base model id, like `qwen.qwen3-32b-v1:0`. */
  readonly modelId: string;
  readonly guardrailId: string;
  readonly guardrailVersion: string;
  readonly guardrailArn: string;
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
    // foundation model in this region, and applies the one guardrail, nothing else.
    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.logGroup.grantWrite(role);

    // Converse is authorized as InvokeModel. The model is called on demand in this stack's region
    // with no inference profile, and a foundation-model ARN carries no account.
    // R17.x (contributor's call, D-064): no bedrock:InferenceProfileArn condition. It applies only to
    // profile-routed calls, would block this on-demand invocation, and the ARN is already one model.
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          stack.formatArn({
            service: 'bedrock',
            account: '',
            resource: 'foundation-model',
            resourceName: props.modelId,
          }),
        ],
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
