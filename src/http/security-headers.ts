/** Browser-facing response hardening shared by Node and Worker dispatch. */

export const INLINE_STYLESHEET_SHA256 = 'eaKv+q+fB5vyFM1uIwPi3NEYW8n9LWRvTLBxCB6B1RY=';

export const BROWSER_SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'none'",
    `style-src 'sha256-${INLINE_STYLESHEET_SHA256}'`,
    'upgrade-insecure-requests',
  ].join('; '),
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'origin-agent-cluster': '?1',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'x-permitted-cross-domain-policies': 'none',
} as const;

/** Authenticated application and API responses must not enter shared caches. */
export function requiresNoStore(path: string): boolean {
  return (
    path === '/app' || path.startsWith('/app/') || path === '/api/v0' || path.startsWith('/api/v0/')
  );
}
