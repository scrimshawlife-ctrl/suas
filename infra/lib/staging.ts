/**
 * Stack layout for the STAGING environment. `bin/suas.ts` and the tests both call this, so
 * what the tests assert is what `cdk synth` produces.
 *
 * A production stage would be another call with its own EnvironmentConfig. None exists:
 * production is gated by V1_PROJECT_PLAN.md §7.
 */

import type { App } from 'aws-cdk-lib';
import { BackendStack } from './backend-stack.js';
import { loadEnvironmentConfig, stackEnv } from './config.js';
import { DnsStack } from './dns-stack.js';
import { WebCertStack } from './web-cert-stack.js';
import { WebStack } from './web-stack.js';

export interface StagingStacks {
  readonly dns: DnsStack;
  readonly webCert: WebCertStack;
  readonly backend: BackendStack;
  readonly web: WebStack;
}

export function createStagingApp(app: App): StagingStacks {
  const config = loadEnvironmentConfig(app.node);
  const env = stackEnv();
  const prefix = `Suas-${config.name === 'staging' ? 'Staging' : config.name}`;

  // Shared by every environment: the hosted zone.
  const dns = new DnsStack(app, 'Suas-Dns', {
    env,
    rootDomain: config.rootDomain,
    crossRegionReferences: true,
    description: 'SUAS Route 53 hosted zone and mail records',
  });

  const webCert = new WebCertStack(app, `${prefix}-WebCert`, {
    env: { ...env, region: 'us-east-1' },
    crossRegionReferences: true,
    zone: dns.zone,
    webHostname: config.webHostname,
    description: `SUAS ${config.name} CloudFront certificate (us-east-1)`,
  });

  const backend = new BackendStack(app, `${prefix}-Backend`, {
    env,
    config,
    zone: dns.zone,
    description: `SUAS ${config.name} backend: VPC, RDS, API, jobs. Inference and chat push stay off.`,
  });

  const web = new WebStack(app, `${prefix}-Web`, {
    env,
    crossRegionReferences: true,
    zone: dns.zone,
    webHostname: config.webHostname,
    certificate: webCert.certificate,
    description: `SUAS ${config.name} web app: S3 and CloudFront`,
  });

  return { dns, webCert, backend, web };
}
