/**
 * The CloudFront certificate. CloudFront only accepts certificates from us-east-1, so this
 * is its own stack in that region; `crossRegionReferences` hands the certificate to the web
 * stack in us-west-2.
 *
 * Validation is by DNS records in the hosted zone. Deploying waits until ACM sees those
 * records, which means the registrar must already delegate the domain to Route 53.
 */

import { Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import type * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

export interface WebCertStackProps extends StackProps {
  readonly zone: route53.IHostedZone;
  readonly webHostname: string;
}

export class WebCertStack extends Stack {
  readonly certificate: acm.Certificate;

  constructor(scope: Construct, id: string, props: WebCertStackProps) {
    super(scope, id, props);
    this.certificate = new acm.Certificate(this, 'WebCertificate', {
      domainName: props.webHostname,
      validation: acm.CertificateValidation.fromDns(props.zone),
    });
  }
}
