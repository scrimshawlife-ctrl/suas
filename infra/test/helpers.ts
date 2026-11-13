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

/** What the validator sees for the SSM fixture registry: one synthetic tenant-id:user-id pair. */
export const SAMPLE_FIXTURE_REGISTRY =
  '00000000-0000-4000-8000-000000000001:11111111-1111-4111-8111-111111111111';

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
    // A template parameter resolved from SSM at deploy (pass Parameters in with the resources).
    if (type === 'AWS::SSM::Parameter::Value<String>') return SAMPLE_FIXTURE_REGISTRY;
    return logicalId.toLowerCase();
  }
  if ('Fn::GetAtt' in node)
    return `${String((node['Fn::GetAtt'] as string[])[0]).toLowerCase()}.example.invalid`;
  if ('Fn::Join' in node) {
    const [sep, parts] = node['Fn::Join'] as [string, Json[]];
    const secretRef = parts[1] as Record<string, Json> | undefined;
    if (
      parts.length === 3 &&
      parts[0] === '{{resolve:secretsmanager:' &&
      parts[2] === ':SecretString:::}}' &&
      secretRef !== undefined &&
      'Ref' in secretRef
    ) {
      // A whole generated secret: 64 letters and digits, distinct per secret, like the real one.
      const seed = String(secretRef.Ref).replace(/[^A-Za-z0-9]/g, '');
      return seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64);
    }
    return parts.map((part) => resolveForValidation(part, resources)).join(sep);
  }
  throw new Error(`Unhandled intrinsic: ${JSON.stringify(value)}`);
}
