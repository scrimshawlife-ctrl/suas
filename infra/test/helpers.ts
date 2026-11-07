import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { createStagingApp, type StagingStacks } from '../lib/staging.js';

export interface Synthesized {
  readonly stacks: StagingStacks;
  readonly dns: Template;
  readonly webCert: Template;
  readonly backend: Template;
  readonly web: Template;
}

/** Synthesizes the staging app in memory. Offline: no lookups, no credentials. */
export function synthesize(context: Record<string, string> = {}): Synthesized {
  const app = new App({ context });
  const stacks = createStagingApp(app);
  return {
    stacks,
    dns: Template.fromStack(stacks.dns),
    webCert: Template.fromStack(stacks.webCert),
    backend: Template.fromStack(stacks.backend),
    web: Template.fromStack(stacks.web),
  };
}

type Json = unknown;

/**
 * Turns a template property into the string the Lambda would see, so the real
 * configuration validator can run on it. References become stable fake values, shaped like
 * the real ones where the validator checks the shape.
 */
export function resolveForValidation(
  value: Json,
  resources: Record<string, { Type: string }>,
): string {
  if (typeof value === 'string') return value;
  const node = value as Record<string, Json>;
  if ('Ref' in node) {
    const logicalId = String(node.Ref);
    if (logicalId === 'AWS::URLSuffix') return 'amazonaws.com';
    const type = resources[logicalId]?.Type;
    if (type === 'AWS::ApiGatewayV2::Api') return 'abc123def4';
    if (type === 'AWS::S3::Bucket') return 'suas-staging-assets-example';
    return logicalId.toLowerCase();
  }
  if ('Fn::GetAtt' in node)
    return `${String((node['Fn::GetAtt'] as string[])[0]).toLowerCase()}.example.invalid`;
  if ('Fn::Join' in node) {
    const [sep, parts] = node['Fn::Join'] as [string, Json[]];
    return parts.map((part) => resolveForValidation(part, resources)).join(sep);
  }
  throw new Error(`Unhandled intrinsic: ${JSON.stringify(value)}`);
}
