/**
 * The STAGING last-hop recipient allowlist (r263 F2, #306). Every real EMAIL adapter checks it
 * before any provider call, so only owner-approved test addresses can receive mail.
 */

import { isStagingFixtureAddress } from '../auth/staging-access.js';

/** May the last hop send to this address? */
export type RecipientAllowed = (to: string) => boolean;

/**
 * A synthetic address (RFC 2606/6761 reserved domains), or a `+tag` address of the configured
 * fixture mailbox (R11.7), never the bare mailbox. With no mailbox configured, only synthetic
 * addresses pass, so nothing real is sent. The STAGING public demo (R16.1, contributor proposal,
 * not released) allows any address.
 */
export function stagingRecipientAllowed(
  mailbox: string | undefined,
  publicDemo = false,
): RecipientAllowed {
  if (publicDemo) return () => true;
  return (to) => isStagingFixtureAddress(to, mailbox);
}
