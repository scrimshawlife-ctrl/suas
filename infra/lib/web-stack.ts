/**
 * The web SPA: a private S3 bucket behind CloudFront with Origin Access Control, on the
 * web hostname, HTTPS only, with unknown paths answered by index.html (client-side routes).
 *
 * `web/dist` is uploaded only when it exists at synth time, so a synth works before the web
 * app has been built. Build it with VITE_SUAS_API_BASE_URL set to the API origin first.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import { repoRoot } from './lambda-code.js';

export interface WebStackProps extends StackProps {
  readonly zone: route53.IHostedZone;
  readonly webHostname: string;
  /** Certificate for `webHostname`, from the us-east-1 stack. */
  readonly certificate: acm.ICertificate;
}

export class WebStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      // The site is rebuilt from web/dist, so it can go with the stack.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const spaFallback = (httpStatus: number): cloudfront.ErrorResponse => ({
      httpStatus,
      responseHttpStatus: 200,
      responsePagePath: '/index.html',
      ttl: Duration.seconds(0),
    });

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultRootObject: 'index.html',
      domainNames: [props.webHostname],
      certificate: props.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
      },
      // With OAC and no list permission, S3 answers 403 for a missing key.
      errorResponses: [spaFallback(403), spaFallback(404)],
    });

    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
    const recordName = props.webHostname;
    new route53.ARecord(this, 'WebAlias', { zone: props.zone, recordName, target });
    new route53.AaaaRecord(this, 'WebAliasIpv6', { zone: props.zone, recordName, target });

    const distDir = path.join(repoRoot, 'web', 'dist');
    if (existsSync(path.join(distDir, 'index.html'))) {
      new s3deploy.BucketDeployment(this, 'SiteFiles', {
        sources: [s3deploy.Source.asset(distDir)],
        destinationBucket: this.bucket,
        distribution: this.distribution,
        distributionPaths: ['/*'],
        logGroup: new logs.LogGroup(this, 'SiteFilesLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });
    }

    new CfnOutput(this, 'WebUrl', { value: `https://${props.webHostname}` });
  }
}
