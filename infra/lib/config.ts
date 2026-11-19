/**
 * Deployment settings read from CDK context (`-c key=value` or cdk.json), with the
 * values the user confirmed on 2026-11-05 as defaults. Nothing here is an account id,
 * ARN or secret: the account comes from CDK_DEFAULT_ACCOUNT at deploy time.
 */

import { execFileSync } from 'node:child_process';
import type { Node } from 'constructs';

/** Region of the Dns, Backend and Web stacks unless the `region` context says otherwise. */
export const DEFAULT_REGION = 'us-west-2';

/** Version of the AWS-published Lambda Web Adapter layer (pinned; override with context). */
const DEFAULT_WEB_ADAPTER_LAYER_VERSION = 30;

export interface EnvironmentConfig {
  /** Environment name used in stack and resource names. Only `staging` exists. */
  readonly name: 'staging';
  /** Region of the Dns, Backend and Web stacks. The CloudFront certificate is always us-east-1. */
  readonly region: string;
  /**
   * false: no hosted zone, certificates, custom domains or DNS records. The web runs on the
   * CloudFront domain and the API on its execute-api URL (region-restricted accounts).
   */
  readonly customDomains: boolean;
  /** The web origin the API allows when customDomains is false (the CloudFront URL). */
  readonly webOrigin: string | undefined;
  /** A us-east-1 CloudFront certificate made outside CloudFormation; replaces the WebCert stack. */
  readonly webCertificateArn: string | undefined;
  /** The `SUAS_ENV` class the Lambdas run as. */
  readonly suasEnv: 'STAGING';
  readonly rootDomain: string;
  readonly webHostname: string;
  readonly apiHostname: string;
  readonly safetyCopyMode: 'placeholder_test_only' | 'approved';
  /** Tenant that new sign-ups join (SUAS_BROWSER_TENANT_ID); a plain UUID, not a secret. */
  readonly browserTenantId: string;
  readonly webAdapterLayerVersion: number;
  /** AZ names to pin; empty means the stack picks the first two with Fn::GetAZs (no lookup). */
  readonly availabilityZones: readonly string[];
  readonly buildCommit: string;
  readonly buildTimestamp: string;
  /**
   * VA confirmation through the outside-VPC verify function (VA_CONFIRMATION_FLOW W9 item 4).
   * Off by default: the API keeps SUAS_VA_CONFIRMATION_MODE=disabled and no verify function exists.
   */
  readonly vaSandbox: boolean;
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

function trueOrFalse(node: Node, key: string, fallback: 'true' | 'false'): boolean {
  const value = text(node, key) ?? fallback;
  if (value !== 'true' && value !== 'false') {
    throw new Error(`Context "${key}" must be true or false.`);
  }
  return value === 'true';
}

/** An exact https origin, as the API's CORS allowlist needs it: no path, query or trailing slash. */
function httpsOrigin(key: string, value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== 'https:' || url.origin !== value) {
    throw new Error(
      `Context "${key}" must be an https origin with no path, like https://d111.cloudfront.net; got "${value}".`,
    );
  }
  return value;
}

export function loadEnvironmentConfig(node: Node): EnvironmentConfig {
  const region = text(node, 'region') ?? DEFAULT_REGION;
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(region)) {
    throw new Error(`Context "region" must be an AWS region name like us-east-2; got "${region}".`);
  }

  const customDomains = trueOrFalse(node, 'customDomains', 'true');
  const webOriginText = text(node, 'webOrigin');
  if (webOriginText !== undefined && customDomains) {
    throw new Error(
      'Context "webOrigin" is only for customDomains=false; with custom domains the API allows https://<webHostname>.',
    );
  }
  const webOrigin =
    webOriginText === undefined ? undefined : httpsOrigin('webOrigin', webOriginText);
  const webCertificateArn = text(node, 'webCertificateArn');
  if (webCertificateArn !== undefined) {
    if (!customDomains) {
      throw new Error('Context "webCertificateArn" needs customDomains=true.');
    }
    // CloudFront only accepts certificates from us-east-1.
    if (!/^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]+$/.test(webCertificateArn)) {
      throw new Error(
        `Context "webCertificateArn" must be an ACM certificate ARN in us-east-1; got "${webCertificateArn}".`,
      );
    }
  }

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
  if (zones.length > 0 && (zones.length < 2 || zones.some((zone) => !zone.startsWith(region)))) {
    throw new Error(`Context "availabilityZones" must list at least two ${region} zones.`);
  }

  const vaSandbox = trueOrFalse(node, 'vaSandbox', 'false');

  return {
    name: 'staging',
    region,
    customDomains,
    webOrigin,
    webCertificateArn,
    suasEnv: 'STAGING',
    rootDomain,
    webHostname,
    apiHostname,
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
    vaSandbox,
  };
}

/** Stack env: region from context, account taken from the CLI at deploy time (never committed). */
export function stackEnv(config: EnvironmentConfig): {
  account: string | undefined;
  region: string;
} {
  return { account: process.env.CDK_DEFAULT_ACCOUNT, region: config.region };
}
