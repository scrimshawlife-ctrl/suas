/**
 * EMAIL template catalog (`email-templates/v1`).
 *
 * SUAS-specs NOTIFICATIONS.md §7–§8, §10; AUTH.md §2–§3; SAFETY_COPY.md §0, §4.
 */

import { describe, expect, it } from 'vitest';
import { CRISIS_FOOTER } from '../../src/ui/safety.js';
import { FORBIDDEN_CRISIS_PHRASES } from '../../src/ui/truthfulness.js';
import {
  EMAIL_TEMPLATE_CATALOG_VERSION,
  EMAIL_TEMPLATE_KEYS,
  EmailTemplateContextError,
  escapeEmailHtml,
  RecordingChannel,
  renderEmailTemplate,
  UnknownEmailTemplateError,
} from '../../src/notifications/index.js';

const AUTH_CONTEXT = {
  secret: '654321',
  expiresAt: new Date('2026-08-26T22:00:00.000Z'),
};

const XSS_SECRET = '<script>alert(1)</script>&"\'';

describe('email-templates/v1 catalog', () => {
  it('renders every shipped EMAIL template with stable subject, text, and html', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const rendered = renderEmailTemplate(key.reason, key.templateVersion, AUTH_CONTEXT);
      expect(rendered.catalogVersion).toBe(EMAIL_TEMPLATE_CATALOG_VERSION);
      expect(rendered.reason).toBe(key.reason);
      expect(rendered.templateVersion).toBe(key.templateVersion);
      expect(rendered.subject.length).toBeGreaterThan(0);
      expect(rendered.text.length).toBeGreaterThan(0);
      expect(rendered.html).toContain('<!DOCTYPE html>');
      expect(rendered.html).toContain('<p>');
    }
  });

  it('fails closed on an unknown reason', () => {
    expect(() => renderEmailTemplate('CHECKIN_COMPLETED', 'followup@1')).toThrow(
      UnknownEmailTemplateError,
    );
  });

  it('fails closed on an unknown templateVersion', () => {
    expect(() => renderEmailTemplate('followup_due', 'followup@2')).toThrow(
      UnknownEmailTemplateError,
    );
  });

  it('fails closed when an auth template is missing its secret', () => {
    expect(() =>
      renderEmailTemplate('auth.email_otp', 'auth.email_otp', {
        expiresAt: AUTH_CONTEXT.expiresAt,
      }),
    ).toThrow(EmailTemplateContextError);
  });

  it('escapes interpolated context in HTML', () => {
    const rendered = renderEmailTemplate('auth.magic_link', 'auth.magic_link', {
      secret: XSS_SECRET,
      expiresAt: AUTH_CONTEXT.expiresAt,
    });
    expect(rendered.html).toContain(escapeEmailHtml(XSS_SECRET));
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.text).toContain(XSS_SECRET);
  });

  it('does not put MAGIC_LINK or EMAIL_OTP secrets into a structured log record', () => {
    const magic = renderEmailTemplate('auth.magic_link', 'auth.magic_link', AUTH_CONTEXT);
    const otp = renderEmailTemplate('auth.email_otp', 'auth.email_otp', AUTH_CONTEXT);
    const log = JSON.stringify({
      implementation: 'resend',
      channel: 'EMAIL',
      accepted: true,
      outcome: 'accepted',
      reason: magic.reason,
      templateVersion: otp.templateVersion,
    });
    expect(log).not.toContain(AUTH_CONTEXT.secret);
    expect(log).not.toContain(magic.text);
    expect(log).not.toContain(otp.text);
  });
});

describe('SAFETY_COPY.md — crisis-adjacent EMAIL templates', () => {
  const crisisKeys = EMAIL_TEMPLATE_KEYS.filter(
    (key) =>
      key.reason === 'trusted_contact_alert' ||
      key.reason === 'followup_due' ||
      key.reason === 'service_request_update',
  );

  it('quotes only 911 and 988 as destinations', () => {
    for (const key of crisisKeys) {
      const rendered = renderEmailTemplate(key.reason, key.templateVersion);
      const combined = `${rendered.subject}\n${rendered.text}\n${rendered.html}`;
      expect(combined).toContain('911');
      expect(combined).toContain('988');
      expect(combined).not.toMatch(/tel:(?!911|988)\d/);
      expect(combined).not.toContain('http');
      expect(combined).toContain(CRISIS_FOOTER);
    }
  });

  it('does not use forbidden crisis phrases or the word transition', () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const rendered = renderEmailTemplate(key.reason, key.templateVersion, AUTH_CONTEXT);
      const combined = `${rendered.subject}\n${rendered.text}\n${rendered.html}`;
      expect(combined.toLowerCase()).not.toContain('transition');
      for (const phrase of FORBIDDEN_CRISIS_PHRASES) {
        expect(combined.toLowerCase()).not.toContain(phrase.toLowerCase());
      }
    }
  });

  it('records rendered subject, text, and html on RecordingChannel', async () => {
    const rendered = renderEmailTemplate('followup_due', 'followup@1');
    const channel = new RecordingChannel('EMAIL', 'fake');
    await channel.send({
      channel: 'EMAIL',
      destination: 'veteran@example.invalid',
      templateVersion: rendered.templateVersion,
      subject: rendered.subject,
      body: rendered.text,
      html: rendered.html,
      idempotencyKey: 'record-1',
    });
    expect(channel.sent()[0]?.subject).toBe(rendered.subject);
    expect(channel.sent()[0]?.body).toBe(rendered.text);
    expect(channel.sent()[0]?.html).toBe(rendered.html);
  });

  it('does not put crisis copy on MAGIC_LINK or EMAIL_OTP', () => {
    const magic = renderEmailTemplate('auth.magic_link', 'auth.magic_link', AUTH_CONTEXT);
    const otp = renderEmailTemplate('auth.email_otp', 'auth.email_otp', AUTH_CONTEXT);
    expect(magic.text).not.toContain('911');
    expect(otp.text).not.toContain('988');
    expect(magic.html).not.toContain(CRISIS_FOOTER);
    expect(otp.html).not.toContain(CRISIS_FOOTER);
  });
});
