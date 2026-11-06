/**
 * The CloudFront certificate. CloudFront only accepts certificates from us-east-1, so this
 * is its own stack in that region; `crossRegionReferences` hands the certificate to the web
 * stack in us-west-2.
 *
 * Validation is by DNS records in the hosted zone. Deploying waits until ACM sees those
 * records, which needs the registrar to delegate the domain to Route 53. That cutover
 * waits for the suas-specs #61 R6.8 gate and an owner decision (see README). Do not
 * change name servers to unblock this stack.
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
