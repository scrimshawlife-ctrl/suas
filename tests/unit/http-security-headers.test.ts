import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BROWSER_SECURITY_HEADERS,
  INLINE_STYLESHEET_SHA256,
  requiresNoStore,
} from '../../src/http/security-headers.js';
import { STYLESHEET } from '../../src/ui/theme.js';

describe('browser response security headers', () => {
  it('fails closed for scripts, framing, capabilities, and referrers', () => {
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("default-src 'none'");
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("script-src 'none'");
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(BROWSER_SECURITY_HEADERS['x-frame-options']).toBe('DENY');
    expect(BROWSER_SECURITY_HEADERS['cross-origin-embedder-policy']).toBe('require-corp');
    expect(BROWSER_SECURITY_HEADERS['cross-origin-opener-policy']).toBe('same-origin');
    expect(BROWSER_SECURITY_HEADERS['cross-origin-resource-policy']).toBe('same-origin');
    expect(BROWSER_SECURITY_HEADERS['origin-agent-cluster']).toBe('?1');
    expect(BROWSER_SECURITY_HEADERS['x-permitted-cross-domain-policies']).toBe('none');
    expect(BROWSER_SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(BROWSER_SECURITY_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(BROWSER_SECURITY_HEADERS['permissions-policy']).toContain('camera=()');
    expect(BROWSER_SECURITY_HEADERS['strict-transport-security']).toContain('max-age=31536000');
  });

  it('authorizes only the exact shipped inline stylesheet', () => {
    const digest = createHash('sha256').update(STYLESHEET, 'utf8').digest('base64');
    expect(INLINE_STYLESHEET_SHA256).toBe(digest);
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).toContain(
      `style-src 'sha256-${digest}'`,
    );
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("font-src 'none'");
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).not.toContain("'unsafe-inline'");
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).not.toContain(
      'fonts.googleapis.com',
    );
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).not.toContain('fonts.gstatic.com');
  });

  it('prevents caching application and canonical API responses', () => {
    expect(requiresNoStore('/app')).toBe(true);
    expect(requiresNoStore('/app/home')).toBe(true);
    expect(requiresNoStore('/api/v0/health')).toBe(true);
    expect(requiresNoStore('/docs')).toBe(false);
  });
});
