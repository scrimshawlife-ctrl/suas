const RETIRED_SHARED_ACCOUNT_SUFFIX = '.zer0state-noema.workers.dev';

function configuredUrl(value: string | undefined, variableName: string): URL {
  if (!value?.trim()) {
    throw new Error(
      `${variableName} must name the independently owned SUAS synthetic-STAGING origin. ` +
        'There is intentionally no default deployment host.',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be an absolute HTTPS origin.`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`${variableName} must use HTTPS.`);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(
      `${variableName} must be an origin without credentials, path, query, or fragment.`,
    );
  }
  if (url.hostname.endsWith(RETIRED_SHARED_ACCOUNT_SUFFIX)) {
    throw new Error(
      `${variableName} must not target the retired shared-account workers.dev host. ` +
        'Provision an independent SUAS Cloudflare account/subdomain or custom staging hostname.',
    );
  }

  return url;
}

/**
 * Resolves a non-secret synthetic-STAGING origin only after its owner has
 * independently provisioned and configured it. This validates a hostname but
 * cannot attest to Cloudflare account ownership, which remains an owner check.
 */
export function resolveSyntheticStagingOrigin(
  value: string | undefined,
  variableName: string,
): string {
  return configuredUrl(value, variableName).origin;
}
