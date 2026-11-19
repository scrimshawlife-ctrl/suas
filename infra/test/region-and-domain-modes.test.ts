/**
 * The `region`, `customDomains`, `webOrigin` and `webCertificateArn` contexts: a deploy into a
 * region-restricted account on AWS default URLs, and a CloudFront certificate made by CLI.
 * The default layout is covered by staging.test.ts.
 */

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { tryLoadConfig } from '../../src/config/index.js';
import { createStagingApp } from '../lib/staging.js';
import { resolveForValidation } from './helpers.js';

type Resource = { Type: string; Properties?: Record<string, any> };

function synth(context: Record<string, string>) {
  const stacks = createStagingApp(new App({ context }));
  return {
    stacks,
    backend: Template.fromStack(stacks.backend).toJSON(),
    web: Template.fromStack(stacks.web).toJSON(),
  };
}

const resourcesOf = (template: Record<string, any>): Array<[string, Resource]> =>
  Object.entries(template.Resources as Record<string, Resource>);
const ofType = (template: Record<string, any>, type: string): Resource[] =>
  resourcesOf(template)
    .filter(([, r]) => r.Type === type)
    .map(([, r]) => r);
const fn = (template: Record<string, any>, handler: string): Record<string, any> => {
  const found = ofType(template, 'AWS::Lambda::Function').find(
    (r) => r.Properties?.Handler === handler,
  );
  if (found?.Properties === undefined) throw new Error(`Missing function ${handler}`);
  return found.Properties;
};
// The API function's environment as the application's own configuration validator reads it.
function apiConfig(backend: Record<string, any>) {
  const resources = { ...backend.Resources, ...backend.Parameters };
  const variables = fn(backend, 'run.sh').Environment.Variables as Record<string, unknown>;
  const env = Object.fromEntries(
    Object.entries(variables).map(([k, v]) => [k, resolveForValidation(v, resources)]),
  );
  return tryLoadConfig(env);
}
const distributionConfig = (web: Record<string, any>): Record<string, any> =>
  ofType(web, 'AWS::CloudFront::Distribution')[0]?.Properties?.DistributionConfig;

const DEFAULT_URLS = {
  region: 'us-east-2',
  customDomains: 'false',
  webOrigin: 'https://d1.cloudfront.net',
  vaSandbox: 'true',
  safetyCopyMode: 'approved',
};

describe('region-restricted account on default URLs', () => {
  const s = synth(DEFAULT_URLS);

  it('builds only the Backend and Web stacks, both in the chosen region', () => {
    expect(s.stacks.dns).toBeUndefined();
    expect(s.stacks.webCert).toBeUndefined();
    expect(s.stacks.backend.region).toBe('us-east-2');
    expect(s.stacks.web.region).toBe('us-east-2');
  });

  it('creates no certificate, custom domain or DNS record', () => {
    for (const template of [s.backend, s.web]) {
      const types = resourcesOf(template).map(([, r]) => r.Type);
      expect(types).not.toContain('AWS::CertificateManager::Certificate');
      expect(types).not.toContain('AWS::ApiGatewayV2::DomainName');
      expect(types).not.toContain('AWS::ApiGatewayV2::ApiMapping');
      expect(types.filter((type) => type.startsWith('AWS::Route53::'))).toEqual([]);
    }
  });

  it('serves the API on its execute-api URL from the $default stage', () => {
    expect(ofType(s.backend, 'AWS::ApiGatewayV2::Api')[0]?.Properties).toMatchObject({
      DisableExecuteApiEndpoint: false,
    });
    expect(ofType(s.backend, 'AWS::ApiGatewayV2::Stage')[0]?.Properties?.StageName).toBe(
      '$default',
    );
    expect(s.backend.Outputs.ApiUrl.Value).toEqual({
      'Fn::GetAtt': [expect.stringMatching(/^HttpApi/), 'ApiEndpoint'],
    });
  });

  it('runs the API in the region with the CloudFront origin allowed', () => {
    const api = fn(s.backend, 'run.sh');
    expect(api.Environment.Variables).toMatchObject({
      SUAS_AWS_REGION: 'us-east-2',
      SUAS_CORS_ALLOWED_ORIGINS: 'https://d1.cloudfront.net',
    });
    expect(api.Layers).toEqual([
      expect.stringMatching(
        /^arn:aws:lambda:us-east-2:753240598075:layer:LambdaAdapterLayerArm64:/,
      ),
    ]);
    const result = apiConfig(s.backend);
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (result.ok) expect(result.config.corsAllowedOrigins).toEqual(['https://d1.cloudfront.net']);
  });

  it('keeps the reserved-concurrency caps', () => {
    expect(fn(s.backend, 'run.sh').ReservedConcurrentExecutions).toBe(15);
    expect(fn(s.backend, 'job-worker.handler').ReservedConcurrentExecutions).toBe(2);
    expect(fn(s.backend, 'migrate.handler').ReservedConcurrentExecutions).toBe(1);
  });

  it('serves the web on the CloudFront domain', () => {
    const config = distributionConfig(s.web);
    expect(config).not.toHaveProperty('Aliases');
    expect(JSON.stringify(config.ViewerCertificate ?? {})).not.toContain('AcmCertificateArn');
    expect(s.web.Outputs.WebUrl.Value).toEqual({
      'Fn::Join': ['', ['https://', { 'Fn::GetAtt': [expect.any(String), 'DomainName'] }]],
    });
  });

  it('keeps the deploy-workflow caps as Fn::If under deploymentPipeline', () => {
    const { backend } = synth({ ...DEFAULT_URLS, deploymentPipeline: 'true' });
    const api = JSON.stringify(fn(backend, 'run.sh').ReservedConcurrentExecutions);
    const worker = JSON.stringify(fn(backend, 'job-worker.handler').ReservedConcurrentExecutions);
    expect(api).toContain('Fn::If');
    expect(api).toContain('15');
    expect(worker).toContain('Fn::If');
    expect(worker).toContain('2');
    expect(fn(backend, 'migrate.handler').ReservedConcurrentExecutions).toBe(1);
  });
});

describe('default URLs before the web origin is known', () => {
  it('sets no CORS allowlist on the API, and the API still starts', () => {
    const { backend } = synth({ region: 'us-east-2', customDomains: 'false' });
    expect(fn(backend, 'run.sh').Environment.Variables).not.toHaveProperty(
      'SUAS_CORS_ALLOWED_ORIGINS',
    );
    const result = apiConfig(backend);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });
});

describe('a CloudFront certificate made outside CloudFormation', () => {
  const arn = 'arn:aws:acm:us-east-1:123456789012:certificate/0000-1111-2222';

  it('skips the WebCert stack and puts the ARN on the distribution', () => {
    const s = synth({ webCertificateArn: arn });
    expect(s.stacks.webCert).toBeUndefined();
    expect(s.stacks.dns).toBeDefined();
    const config = distributionConfig(s.web);
    expect(config.Aliases).toEqual(['staging.suasqrf.com']);
    expect(config.ViewerCertificate.AcmCertificateArn).toBe(arn);
  });
});

describe('refused contexts', () => {
  const refuse = (context: Record<string, string>, message: RegExp) =>
    expect(() => createStagingApp(new App({ context }))).toThrow(message);

  it('refuses invalid combinations and values', () => {
    refuse({ region: 'us-east' }, /"region"/);
    refuse({ region: 'US-EAST-2' }, /"region"/);
    refuse({ customDomains: 'no' }, /"customDomains" must be true or false/);
    refuse({ webOrigin: 'https://d1.cloudfront.net' }, /only for customDomains=false/);
    const noDomains = { customDomains: 'false' };
    refuse({ ...noDomains, webOrigin: 'http://d1.cloudfront.net' }, /https origin/);
    refuse({ ...noDomains, webOrigin: 'https://d1.cloudfront.net/app' }, /https origin/);
    refuse({ ...noDomains, webOrigin: 'https://d1.cloudfront.net/' }, /https origin/);
    refuse(
      { webCertificateArn: 'arn:aws:acm:us-east-2:123456789012:certificate/0000' },
      /us-east-1/,
    );
    refuse(
      { ...noDomains, webCertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/0000' },
      /needs customDomains=true/,
    );
    refuse(
      { region: 'us-east-2', availabilityZones: 'us-west-2a,us-west-2b' },
      /two us-east-2 zones/,
    );
  });
});
