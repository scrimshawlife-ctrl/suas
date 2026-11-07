/**
 * Deployment settings read from CDK context (`-c key=value` or cdk.json), with the
 * values the user confirmed on 2026-11-05 as defaults. Nothing here is an account id,
 * ARN or secret: the account comes from CDK_DEFAULT_ACCOUNT at deploy time.
 */

import { execFileSync } from 'node:child_process';
import type { Node } from 'constructs';

export const REGION = 'us-west-2';

/** Version of the AWS-published Lambda Web Adapter layer (pinned; override with context). */
const DEFAULT_WEB_ADAPTER_LAYER_VERSION = 30;

export interface EnvironmentConfig {
  /** Environment name used in stack and resource names. Only `staging` exists. */
  readonly name: 'staging';
  /** The `SUAS_ENV` class the Lambdas run as. */
  readonly suasEnv: 'STAGING';
  readonly rootDomain: string;
  readonly webHostname: string;
  readonly apiHostname: string;
  readonly emailFrom: string;
  readonly safetyCopyMode: 'placeholder_test_only' | 'approved';
  /** Tenant that new sign-ups join (SUAS_BROWSER_TENANT_ID); a plain UUID, not a secret. */
  readonly browserTenantId: string;
  readonly webAdapterLayerVersion: number;
  /** AZ names to pin; empty means the stack picks the first two with Fn::GetAZs (no lookup). */
  readonly availabilityZones: readonly string[];
  readonly buildCommit: string;
  readonly buildTimestamp: string;
}

function text(node: Node, key: string): string | undefined {
  const value: unknown = node.tryGetContext(key);
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function hostnameWithin(root: string, key: string, value: string): string {
  const ok = value === root || value.endsWith(`.${root}`);
  if (!ok || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value)) {
    throw new Error(
      `Context "${key}" must be a host name inside ${root} (the hosted zone this app owns); got "${value}".`,
    );
  }
  return value;
}

export function loadEnvironmentConfig(node: Node): EnvironmentConfig {
  const rootDomain = text(node, 'rootDomain') ?? 'suasqrf.com';
  const webHostname = hostnameWithin(
    rootDomain,
    'webHostname',
    text(node, 'webHostname') ?? 'staging.suasqrf.com',
  );
  const apiHostname = hostnameWithin(
    rootDomain,
    'apiHostname',
    text(node, 'apiHostname') ?? 'api.staging.suasqrf.com',
  );

  // R2.15 is not approved. A model id must not turn inference on.
  if (
    text(node, 'bedrockModelId') !== undefined ||
    text(node, 'allowPlaceholderModel') !== undefined
  ) {
    throw new Error(
      'Staging leaves SUAS_MODEL_INFERENCE_MODE=disabled. R2.15 is not approved, so ' +
        'bedrockModelId and allowPlaceholderModel are refused. The Bedrock adapter in ' +
        'src/inference/bedrock-inference.ts stays unused by this template.',
    );
  }

  const safety = text(node, 'safetyCopyMode') ?? 'placeholder_test_only';
  if (safety !== 'placeholder_test_only' && safety !== 'approved') {
    throw new Error('Context "safetyCopyMode" must be placeholder_test_only or approved.');
  }

  const tenant = text(node, 'browserTenantId') ?? '00000000-0000-4000-8000-000000000001';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
    throw new Error('Context "browserTenantId" must be a UUID.');
  }

  const layerVersion = Number(
    text(node, 'webAdapterLayerVersion') ?? DEFAULT_WEB_ADAPTER_LAYER_VERSION,
  );
  if (!Number.isInteger(layerVersion) || layerVersion < 1) {
    throw new Error('Context "webAdapterLayerVersion" must be a positive integer.');
  }

  const zones = (text(node, 'availabilityZones') ?? '')
    .split(',')
    .map((zone) => zone.trim())
    .filter((zone) => zone !== '');
  if (zones.length > 0 && (zones.length < 2 || zones.some((zone) => !zone.startsWith(REGION)))) {
    throw new Error(`Context "availabilityZones" must list at least two ${REGION} zones.`);
  }

  return {
    name: 'staging',
    suasEnv: 'STAGING',
    rootDomain,
    webHostname,
    apiHostname,
    emailFrom: text(node, 'emailFrom') ?? `no-reply@${rootDomain}`,
    safetyCopyMode: safety,
    browserTenantId: tenant,
    webAdapterLayerVersion: layerVersion,
    availabilityZones: zones,
    // Stamped at build time (ENVIRONMENT.md §8). The commit date, not "now", keeps the
    // synthesized template identical between runs of the same commit.
    buildCommit:
      text(node, 'buildCommit') ??
      process.env.SUAS_BUILD_COMMIT ??
      git(['rev-parse', 'HEAD']) ??
      'unknown',
    buildTimestamp:
      text(node, 'buildTimestamp') ??
      process.env.SUAS_BUILD_TIMESTAMP ??
      git(['show', '-s', '--format=%cI', 'HEAD']) ??
      'unknown',
  };
}

/** Stack env: region fixed, account taken from the CLI at deploy time (never committed). */
export function stackEnv(): { account: string | undefined; region: string } {
  return { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };
}
