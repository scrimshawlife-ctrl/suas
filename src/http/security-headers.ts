/** Browser-facing response hardening shared by Node and Worker dispatch. */

export const INLINE_STYLESHEET_SHA256 = 'XXw2y0a1mhiKVAuZCy8VLuxokUlKBtZN6jIFEsiSmMo=';

export const BROWSER_SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "base-uri 'none'",
    "connect-src 'self'",
    'font-src https://fonts.gstatic.com',
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "script-src 'none'",
    `style-src 'self' 'sha256-${INLINE_STYLESHEET_SHA256}' https://fonts.googleapis.com`,
    'upgrade-insecure-requests',
  ].join('; '),
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const;

/** Authenticated application and API responses must not enter shared caches. */
export function requiresNoStore(path: string): boolean {
  return (
    path === '/app' || path.startsWith('/app/') || path === '/api/v0' || path.startsWith('/api/v0/')
  );
}
