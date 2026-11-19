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
  /** Absent when customDomains is false. */
  readonly dns: DnsStack | undefined;
  /** Absent when customDomains is false or webCertificateArn names a certificate made by CLI. */
  readonly webCert: WebCertStack | undefined;
  readonly backend: BackendStack;
  readonly web: WebStack;
}

export function createStagingApp(app: App): StagingStacks {
  const config = loadEnvironmentConfig(app.node);
  const env = stackEnv(config);
  const prefix = `Suas-${config.name === 'staging' ? 'Staging' : config.name}`;

  // Shared by every environment: the hosted zone.
  const dns = config.customDomains
    ? new DnsStack(app, 'Suas-Dns', {
        env,
        rootDomain: config.rootDomain,
        crossRegionReferences: true,
        description: 'SUAS Route 53 hosted zone and mail records',
      })
    : undefined;

  const webCert =
    dns !== undefined && config.webCertificateArn === undefined
      ? new WebCertStack(app, `${prefix}-WebCert`, {
          env: { ...env, region: 'us-east-1' },
          crossRegionReferences: true,
          zone: dns.zone,
          webHostname: config.webHostname,
          description: `SUAS ${config.name} CloudFront certificate (us-east-1)`,
        })
      : undefined;

  const backend = new BackendStack(app, `${prefix}-Backend`, {
    env,
    config,
    zone: dns?.zone,
    description: `SUAS ${config.name} backend: VPC, RDS, API, jobs. Inference and chat push stay off.`,
  });

  const web = new WebStack(app, `${prefix}-Web`, {
    env,
    crossRegionReferences: webCert !== undefined,
    zone: dns?.zone,
    webHostname: config.webHostname,
    certificate: webCert?.certificate ?? config.webCertificateArn,
    description: `SUAS ${config.name} web app: S3 and CloudFront`,
  });

  return { dns, webCert, backend, web };
}
