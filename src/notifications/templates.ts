/**
 * Versioned EMAIL template catalog (`email-templates/v1`).
 *
 * Spec citations:
 * - SUAS-specs NOTIFICATIONS.md §1, §7 (templates render copy; they do not
 *   decide signal level, consent, Trusted Contact alerts, Case closure,
 *   emergency dispatch, or provider eligibility), §8 (generating facts),
 *   §10 (minimum necessary; no bodies in ordinary logs)
 * - SUAS-specs AUTH.md §2–§3 (MAGIC_LINK and EMAIL_OTP where email is configured)
 * - SUAS-specs SAFETY_COPY.md §0, §2.3, §4, §5 (verbatim crisis wording;
 *   destinations are only 911 and 988; REQUESTED ≠ ACCEPTED ≠ DISPATCHED ≠
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
  { reason: 'followup_due', templateVersion: 'followup@1' },
  { reason: 'qrf.responder_notified', templateVersion: 'test@1' },
  { reason: 'service_request_update', templateVersion: 'update@1' },
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

function renderFollowUpDue(): RenderedEmail {
  const subject = 'SUAS Follow-Up is due';
  const text =
    'A Follow-Up on a Support Case is due. This notice does not mean a later ' +
    `support state has occurred.\n\n${CRISIS_FOOTER}`;
  return {
    catalogVersion: EMAIL_TEMPLATE_CATALOG_VERSION,
    reason: 'followup_due',
    templateVersion: 'followup@1',
    subject,
    text,
    html: htmlDocument(
      [
        'A Follow-Up on a Support Case is due. This notice does not mean a later ' +
          'support state has occurred.',
      ],
      CRISIS_FOOTER,
    ),
  };
}

function renderResponderNotified(): RenderedEmail {
  const subject = 'SUAS responder notice';
  const text =
    'SUAS recorded that a responder was notified about a Service Request. ' +
    'This notice records that the notification was created. It does not mean ' +
    'the request was accepted, dispatched, or resolved.';
  return {
    catalogVersion: EMAIL_TEMPLATE_CATALOG_VERSION,
    reason: 'qrf.responder_notified',
    templateVersion: 'test@1',
    subject,
    text,
    html: htmlDocument([text], undefined),
  };
}

function renderServiceRequestUpdate(): RenderedEmail {
  const subject = 'SUAS Service Request update';
  const text =
    'A Service Request you can see was updated. This notice does not mean the ' +
    `request was accepted, dispatched, or resolved.\n\n${CRISIS_FOOTER}`;
  return {
    catalogVersion: EMAIL_TEMPLATE_CATALOG_VERSION,
    reason: 'service_request_update',
    templateVersion: 'update@1',
    subject,
    text,
    html: htmlDocument(
      [
        'A Service Request you can see was updated. This notice does not mean the ' +
          'request was accepted, dispatched, or resolved.',
      ],
      CRISIS_FOOTER,
    ),
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
    case 'followup_due':
      return renderFollowUpDue();
    case 'qrf.responder_notified':
      return renderResponderNotified();
    case 'service_request_update':
      return renderServiceRequestUpdate();
    default:
      throw new UnknownEmailTemplateError(reason, templateVersion);
  }
}
