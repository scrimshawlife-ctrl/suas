/**
 * `SUAS_CORS_ALLOWED_ORIGINS` parsing. Dependency-free so the config schema can use
 * it without importing the HTTP layer.
 *
 * Spec citations (D-038, released in SUAS-specs 0.7.0): SUAS-specs ENVIRONMENT.md §3 and
 * AUTH.md §9.3. Exact origins only: `https` (loopback `http` in LOCAL/TEST only), one
 * exact host, `*` anywhere rejected (also percent-encoded `%2a`), trailing-dot hosts and
 * empty host labels rejected, no loopback names or IP literals in STAGING/PRODUCTION, a port
 * only when written and not the scheme default. Fails closed.
 */

export const MAX_CORS_ALLOWED_ORIGINS = 20;

const LOOPBACK_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const HTTP_ALLOWED_ENVIRONMENTS = new Set(['LOCAL', 'TEST']);
const SHARED_ENVIRONMENTS = new Set(['STAGING', 'PRODUCTION']);
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** True when `hostname` (as normalised by URL) is a loopback name or an IP literal. */
function isLoopbackOrIpLiteral(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.startsWith('[') ||
    IPV4_LITERAL.test(hostname)
  );
}

export interface ParsedOrigins {
  readonly origins: readonly string[];
  readonly issues: readonly string[];
}

/**
 * Parse a comma-separated list of exact origins. Anything that is not a plain
 * origin is reported as an issue and is not allowed.
 */
export function parseAllowedOrigins(raw: string | undefined, environment: string): ParsedOrigins {
  if (raw === undefined || raw.trim() === '') return { origins: [], issues: [] };

  const issues: string[] = [];
  const origins = new Set<string>();
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  for (const entry of entries) {
    if (entry.includes('*') || entry.toLowerCase() === 'null') {
      issues.push(
        `SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" is not allowed. List exact origins; wildcards are not supported.`,
      );
      continue;
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      issues.push(`SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" is not a valid origin.`);
      continue;
    }
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      issues.push(
        `SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" must be an origin only: no credentials, path, query, or fragment.`,
      );
      continue;
    }
    // Checked after parsing: URL decodes `%2a` to `*` and keeps empty labels.
    if (url.hostname.includes('*')) {
      issues.push(
        `SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" is not allowed. List exact origins; wildcards are not supported.`,
      );
      continue;
    }
    if (url.hostname === '' || url.hostname.split('.').some((label) => label === '')) {
      issues.push(
        `SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" must name one exact host without a trailing dot or empty label.`,
      );
      continue;
    }
    if (SHARED_ENVIRONMENTS.has(environment) && isLoopbackOrIpLiteral(url.hostname)) {
      issues.push(
        `SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" is not allowed in SUAS_ENV=${environment}: loopback names and IP literals are never owner-controlled origins.`,
      );
      continue;
    }
    if (url.protocol === 'https:') {
      origins.add(url.origin);
    } else if (url.protocol === 'http:') {
      if (HTTP_ALLOWED_ENVIRONMENTS.has(environment) && LOOPBACK_HTTP_HOSTNAMES.has(url.hostname)) {
        origins.add(url.origin);
      } else {
        issues.push(
          `SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" must use https. http is allowed only for localhost, 127.0.0.1, or [::1] in SUAS_ENV=LOCAL or TEST.`,
        );
      }
    } else {
      issues.push(`SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" must use https.`);
    }
  }

  if (origins.size > MAX_CORS_ALLOWED_ORIGINS) {
    issues.push(
      `SUAS_CORS_ALLOWED_ORIGINS lists ${origins.size} origins; the maximum is ${MAX_CORS_ALLOWED_ORIGINS}.`,
    );
  }
  return { origins: [...origins], issues };
}
