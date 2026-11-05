/**
 * DNS and sending identity, shared by every environment.
 *
 * - The public hosted zone for the root domain. It holds no apex or `www` record, so
 *   deploying it does not change what the domain serves today. Nothing resolves from it
 *   until the NS records at the registrar are moved by hand (see README).
 * - The SES domain identity with Easy DKIM, in the zone. An SES identity belongs to a
 *   domain, not to an environment, so it lives here and not in a per-environment stack.
 */

import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as ses from 'aws-cdk-lib/aws-ses';
import type { Construct } from 'constructs';

export interface DnsStackProps extends StackProps {
  readonly rootDomain: string;
}

export class DnsStack extends Stack {
  readonly zone: route53.PublicHostedZone;
  readonly rootDomain: string;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);
    this.rootDomain = props.rootDomain;

    this.zone = new route53.PublicHostedZone(this, 'Zone', { zoneName: props.rootDomain });
    // Deleting the zone would break the registrar delegation and mint new name servers.
    this.zone.applyRemovalPolicy(RemovalPolicy.RETAIN);

    new ses.EmailIdentity(this, 'DomainIdentity', {
      identity: ses.Identity.publicHostedZone(this.zone),
    });

    new CfnOutput(this, 'NameServers', {
      description:
        'Set these as the NS records at the registrar to delegate the domain to Route 53.',
      value: Fn.join(', ', this.zone.hostedZoneNameServers ?? []),
    });
  }

  /** ARN of the SES domain identity, for IAM. No wildcard. */
  get sesIdentityArn(): string {
    return this.formatArn({
      service: 'ses',
      resource: 'identity',
      resourceName: this.rootDomain,
    });
  }
}
