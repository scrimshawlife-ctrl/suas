/**
 * DNS, shared by every environment.
 *
 * - The public hosted zone for the root domain. It holds no apex or `www` record, so
 *   deploying it does not change what the domain serves today. Nothing resolves from it
 *   while the registrar still points at Cloudflare. Changing those name servers waits
 *   for the suas-specs #61 R6.8 gate and an owner decision (see README).
 * - The mail records that exist on Cloudflare today (Resend DKIM, `send` SPF and MX).
 *
 * There is no SES identity: v1 STAGING sends through Gmail SMTP (suas-specs #75 R11.2).
 */

import { CfnOutput, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import type { Construct } from 'constructs';

/** Public DKIM key at `resend._domainkey.suasqrf.com` in the Cloudflare zone (read with dig, 2026-11-05). */
const RESEND_DKIM_PUBLIC_KEY =
  'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDrMvHRhU05sXko0q5D1sB8fH9gt051BBQgB46SggGREJahiVsC3/tmMV4QNQjBl5vi5ih8TFNArxy0O/i1pkMnXBBIGgOWDqF3Jrvl8rHAcM98JQuSX+cQggOwo4WrPBMI6aX1RtjTZIcSX2rKiy/g6dXHTqISnj4HAmTpcC13zQIDAQAB';

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

    // Mail records that exist in the Cloudflare zone today (Resend, D-004). They are public DNS
    // values, not secrets. They are recreated here so outgoing mail can keep working if the
    // registrar later delegates the domain to Route 53. That cutover waits for the suas-specs
    // #61 R6.8 gate and an owner decision (see README). Nothing for the apex or `www` is created.
    if (props.rootDomain === 'suasqrf.com') {
      new route53.TxtRecord(this, 'ResendDkim', {
        zone: this.zone,
        recordName: 'resend._domainkey',
        values: [RESEND_DKIM_PUBLIC_KEY],
      });
      new route53.TxtRecord(this, 'SendSpf', {
        zone: this.zone,
        recordName: 'send',
        values: ['v=spf1 include:amazonses.com ~all'],
      });
      new route53.MxRecord(this, 'SendMx', {
        zone: this.zone,
        recordName: 'send',
        values: [{ priority: 10, hostName: 'feedback-smtp.us-east-1.amazonses.com' }],
      });
    }

    new CfnOutput(this, 'NameServers', {
      description:
        'Route 53 name servers for this zone. Do not change the registrar name servers. That cutover waits for the suas-specs #61 R6.8 gate and an owner decision.',
      value: Fn.join(', ', this.zone.hostedZoneNameServers ?? []),
    });
  }
}
