/**
 * `SUAS_CORS_ALLOWED_ORIGINS` parsing. Dependency-free so the config schema can use
 * it without importing the HTTP layer.
 *
 * Spec citations (DRAFT, proposed D-038): SUAS-specs ENVIRONMENT.md §3 and AUTH.md
 * proposed §9.3. Exact origins only: `https` (loopback `http` in LOCAL/TEST only), one
 * exact host, `*` anywhere rejected, trailing-dot hosts rejected, a port only when written
 * and not the scheme default. Fails closed.
 */

export const MAX_CORS_ALLOWED_ORIGINS = 20;

const LOOPBACK_HTTP_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const HTTP_ALLOWED_ENVIRONMENTS = new Set(['LOCAL', 'TEST']);

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
    if (url.hostname === '' || url.hostname.endsWith('.')) {
      issues.push(
        `SUAS_CORS_ALLOWED_ORIGINS entry "${entry}" must name one exact host without a trailing dot.`,
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
