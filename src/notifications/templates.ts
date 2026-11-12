/**
 * Versioned EMAIL template catalog (`email-templates/v1`).
 *
 * Spec citations:
 * - SUAS-specs NOTIFICATIONS.md §1, §7 (templates render copy; they do not
 *   decide signal level, consent, Trusted Contact alerts, Case closure,
 *   emergency dispatch, or provider eligibility), §8 (generating facts),
 *   §10 (minimum necessary; no bodies in ordinary logs)
 * - SUAS-specs AUTH.md §2–§3 (MAGIC_LINK and EMAIL_OTP where email is configured)
 * - SUAS-specs SAFETY_COPY.md §0, §2.3, §4, §5 (verbatim crisis wording; crisis
 *   destinations come only from SAFETY_COPY; REQUESTED ≠ ACCEPTED ≠ DISPATCHED ≠
 *   ARRIVED ≠ RESOLVED)
 *
 * Keys are OBSERVED `reason` + `templateVersion` pairs already passed to
 * `enqueueNotification` or challenge EMAIL. Unknown pairs fail closed.
 */

import { CRISIS_FOOTER } from '../ui/safety.js';

export const EMAIL_TEMPLATE_CATALOG_VERSION = 'email-templates/v1' as const;

export const EMAIL_TEMPLATE_KEYS = [
  { reason: 'auth.magic_link', templateVersion: 'auth.magic_link' },
  { reason: 'auth.email_otp', templateVersion: 'auth.email_otp' },
  { reason: 'trusted_contact_alert', templateVersion: 'alert@1' },
  { reason: 'trusted_contact_invited', templateVersion: 'invite@1' },
] as const;

export type EmailTemplateReason = (typeof EMAIL_TEMPLATE_KEYS)[number]['reason'];
export type EmailTemplateVersion = (typeof EMAIL_TEMPLATE_KEYS)[number]['templateVersion'];

export interface EmailTemplateContext {
  /** Auth challenge secret. Required for MAGIC_LINK and EMAIL_OTP only. */
  readonly secret?: string;
  readonly expiresAt?: Date;
  /** Canonical entity type name only. Never a row id or destination. */
  readonly subjectType?: string;
}

export interface RenderedEmail {
  readonly catalogVersion: typeof EMAIL_TEMPLATE_CATALOG_VERSION;
  readonly reason: string;
  readonly templateVersion: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export class UnknownEmailTemplateError extends Error {
  readonly code = 'UNKNOWN_EMAIL_TEMPLATE';
  readonly httpStatus = 400;

  constructor(reason: string, templateVersion: string) {
    super(
      `No EMAIL template exists for reason "${reason}" version "${templateVersion}" ` +
        `(catalog ${EMAIL_TEMPLATE_CATALOG_VERSION}). Unknown keys fail closed ` +
        `(SUAS-specs NOTIFICATIONS.md §7–§8).`,
    );
    this.name = 'UnknownEmailTemplateError';
  }
}

export class EmailTemplateContextError extends Error {
  readonly code = 'UNKNOWN_EMAIL_TEMPLATE';
  readonly httpStatus = 400;

  constructor(reason: string, detail: string) {
    super(
      `EMAIL template "${reason}" is missing required context: ${detail}. ` +
        `The renderer fails closed rather than sending incomplete copy.`,
    );
    this.name = 'EmailTemplateContextError';
  }
}

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape interpolated context for HTML. Callers never pass raw markup. */
export function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

function catalogKey(reason: string, templateVersion: string): string {
  return `${reason}\n${templateVersion}`;
}

const KEY_SET = new Set(
  EMAIL_TEMPLATE_KEYS.map((key) => catalogKey(key.reason, key.templateVersion)),
);

function requireSecret(reason: string, context: EmailTemplateContext): string {
  if (context.secret === undefined || context.secret.length === 0) {
    throw new EmailTemplateContextError(reason, 'secret');
  }
  return context.secret;
}

function requireExpiry(reason: string, context: EmailTemplateContext): string {
  if (context.expiresAt === undefined) {
    throw new EmailTemplateContextError(reason, 'expiresAt');
  }
  return context.expiresAt.toISOString();
}

function htmlDocument(paragraphs: readonly string[], footer: string | undefined): string {
  const body = paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('');
  const foot = footer === undefined ? '' : `<footer><p>${escapeEmailHtml(footer)}</p></footer>`;
  return `<!DOCTYPE html><html><body>${body}${foot}</body></html>`;
}

function renderAuthMagicLink(context: EmailTemplateContext): RenderedEmail {
  const secret = requireSecret('auth.magic_link', context);
  const expires = requireExpiry('auth.magic_link', context);
  const subject = 'SUAS sign-in token';
  const text =
    `You requested a SUAS sign-in token. Enter this token in the app to sign in.\n\n` +
    `${secret}\n\n` +
    `This token expires at ${expires}. If you did not request it, ignore this message.`;
  return {
    catalogVersion: EMAIL_TEMPLATE_CATALOG_VERSION,
    reason: 'auth.magic_link',
    templateVersion: 'auth.magic_link',
    subject,
    text,
    html: htmlDocument(
      [
        'You requested a SUAS sign-in token. Enter this token in the app to sign in.',
        escapeEmailHtml(secret),
        `This token expires at ${escapeEmailHtml(expires)}. If you did not request it, ignore this message.`,
      ],
      undefined,
    ),
  };
}

function renderAuthEmailOtp(context: EmailTemplateContext): RenderedEmail {
  const secret = requireSecret('auth.email_otp', context);
  const expires = requireExpiry('auth.email_otp', context);
  const subject = 'SUAS sign-in code';
  const text =
    `Your SUAS sign-in code is ${secret}.\n\n` +
    `This code expires at ${expires}. If you did not request it, ignore this message.`;
  return {
    catalogVersion: EMAIL_TEMPLATE_CATALOG_VERSION,
    reason: 'auth.email_otp',
    templateVersion: 'auth.email_otp',
    subject,
    text,
    html: htmlDocument(
      [
        `Your SUAS sign-in code is ${escapeEmailHtml(secret)}.`,
        `This code expires at ${escapeEmailHtml(expires)}. If you did not request it, ignore this message.`,
      ],
      undefined,
    ),
  };
}

function renderTrustedContactAlert(): RenderedEmail {
  const subject = 'SUAS trusted-contact notice';
  const text =
    'A veteran named you as a trusted contact and asked SUAS to send this notice. ' +
    'This notice does not describe their situation. It does not mean a later support ' +
    `state has occurred.\n\n${CRISIS_FOOTER}`;
  return {
    catalogVersion: EMAIL_TEMPLATE_CATALOG_VERSION,
    reason: 'trusted_contact_alert',
    templateVersion: 'alert@1',
    subject,
    text,
    html: htmlDocument(
      [
        'A veteran named you as a trusted contact and asked SUAS to send this notice. ' +
          'This notice does not describe their situation. It does not mean a later support ' +
          'state has occurred.',
      ],
      CRISIS_FOOTER,
    ),
  };
}

/**
 * TRUSTED_CIRCLE.md §3.2 invite (R9.4, contributor proposal, specs #72). It names nobody:
 * who invited them is shown only after the invitee signs in with this address.
 */
const INVITE_LINES = [
  'A veteran named you as a trusted contact on SUAS.',
  'To see who invited you and to accept, sign in to SUAS with this email address and open Invitations.',
  'Accepting shares nothing about them with you. They decide that separately.',
  'If you were not expecting this, you can ignore this message.',
] as const;

function renderTrustedContactInvite(): RenderedEmail {
  return {
    catalogVersion: EMAIL_TEMPLATE_CATALOG_VERSION,
    reason: 'trusted_contact_invited',
    templateVersion: 'invite@1',
    subject: 'SUAS trusted-contact invitation',
    text: INVITE_LINES.join('\n\n'),
    html: htmlDocument(INVITE_LINES.map(escapeEmailHtml), undefined),
  };
}

/**
 * Render subject, text, and HTML for an OBSERVED reason + templateVersion.
 * EMAIL templates always return both text and HTML.
 */
export function renderEmailTemplate(
  reason: string,
  templateVersion: string,
  context: EmailTemplateContext = {},
): RenderedEmail {
  if (!KEY_SET.has(catalogKey(reason, templateVersion))) {
    throw new UnknownEmailTemplateError(reason, templateVersion);
  }

  switch (reason) {
    case 'auth.magic_link':
      return renderAuthMagicLink(context);
    case 'auth.email_otp':
      return renderAuthEmailOtp(context);
    case 'trusted_contact_alert':
      return renderTrustedContactAlert();
    case 'trusted_contact_invited':
      return renderTrustedContactInvite();
    default:
      throw new UnknownEmailTemplateError(reason, templateVersion);
  }
}
