/**
 * Maintenance controls for the staging deploy workflow (`-c deploymentPipeline=true` only).
 *
 * A `DeploymentMode` parameter steps the backend through maintenance -> api -> worker -> live
 * so migrations run while the API and job worker admit no new work. Reserved concurrency 0 is
 * the admission barrier; the other modes restore the function's own reservation (its fixed cap,
 * or AWS::NoValue when it has none), so no budget is invented and no cap is dropped. The migrate
 * function is left as it is. Without the context the template is unchanged.
 *
 * Trust boundary: changing the mode is a stack update, so it needs `cloudformation:UpdateStack`
 * on the backend stack. That permission already allows any change to the stack, so the parameter
 * grants nothing new. The mode is not secret (no NoEcho): the deploy workflow reads it back.
 */

import { Aws, CfnCondition, CfnOutput, CfnParameter, Fn, type Stack } from 'aws-cdk-lib';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type * as scheduler from 'aws-cdk-lib/aws-scheduler';

export const DEPLOYMENT_MODES = ['maintenance', 'api', 'worker', 'live'] as const;

export interface DeploymentModeTargets {
  readonly api: lambda.Function;
  readonly worker: lambda.Function;
  readonly schedule: scheduler.Schedule;
  readonly databaseIdentifier: string;
  /** Schema the deployed code requires; the next deploy refuses to run older code against it. */
  readonly expectedSchemaVersion: number;
}

/** True when the stack is synthesized for the deploy workflow. */
export function deploymentPipelineEnabled(stack: Stack): boolean {
  const value: unknown = stack.node.tryGetContext('deploymentPipeline');
  return value === true || value === 'true';
}

export function applyDeploymentMode(stack: Stack, targets: DeploymentModeTargets): void {
  const mode = new CfnParameter(stack, 'DeploymentMode', {
    type: 'String',
    default: 'maintenance',
    allowedValues: [...DEPLOYMENT_MODES],
    description: 'Deploy workflow state. maintenance blocks the API and job worker.',
  });
  const is = (value: string) => Fn.conditionEquals(mode.valueAsString, value);
  const apiBlocked = new CfnCondition(stack, 'ApiBlocked', { expression: is('maintenance') });
  const workerBlocked = new CfnCondition(stack, 'WorkerBlocked', {
    expression: Fn.conditionOr(is('maintenance'), is('api')),
  });
  const live = new CfnCondition(stack, 'LiveMode', { expression: is('live') });

  const block = (fn: lambda.Function, condition: CfnCondition) => {
    const cfn = fn.node.defaultChild as lambda.CfnFunction;
    cfn.addPropertyOverride(
      'ReservedConcurrentExecutions',
      Fn.conditionIf(condition.logicalId, 0, cfn.reservedConcurrentExecutions ?? Aws.NO_VALUE),
    );
  };
  block(targets.api, apiBlocked);
  block(targets.worker, workerBlocked);
  (targets.schedule.node.defaultChild as scheduler.CfnSchedule).addPropertyOverride(
    'State',
    Fn.conditionIf(live.logicalId, 'ENABLED', 'DISABLED'),
  );

  new CfnOutput(stack, 'ApiFunctionName', { value: targets.api.functionName });
  new CfnOutput(stack, 'JobWorkerFunctionName', { value: targets.worker.functionName });
  new CfnOutput(stack, 'DatabaseIdentifier', { value: targets.databaseIdentifier });
  new CfnOutput(stack, 'ExpectedSchemaVersion', { value: String(targets.expectedSchemaVersion) });
}
