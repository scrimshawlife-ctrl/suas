import { describe, expect, it } from 'vitest';
import { BROWSER_SECURITY_HEADERS, requiresNoStore } from '../../src/http/security-headers.js';

describe('browser response security headers', () => {
  it('fails closed for scripts, framing, capabilities, and referrers', () => {
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("default-src 'none'");
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("script-src 'none'");
    expect(BROWSER_SECURITY_HEADERS['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(BROWSER_SECURITY_HEADERS['x-frame-options']).toBe('DENY');
    expect(BROWSER_SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(BROWSER_SECURITY_HEADERS['referrer-policy']).toBe('no-referrer');
    expect(BROWSER_SECURITY_HEADERS['permissions-policy']).toContain('camera=()');
    expect(BROWSER_SECURITY_HEADERS['strict-transport-security']).toContain('max-age=31536000');
  });

  it('prevents caching application and canonical API responses', () => {
    expect(requiresNoStore('/app')).toBe(true);
    expect(requiresNoStore('/app/home')).toBe(true);
    expect(requiresNoStore('/api/v0/health')).toBe(true);
    expect(requiresNoStore('/docs')).toBe(false);
  });
});
