/**
 * Synthetic STAGING configuration guard.
 *
 * This deliberately validates names and safe modes without printing values. It
 * is for the existing Worker runtime, not a Cloudflare Pages deployment.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_STAGING_VALUES: Readonly<Record<string, string>> = {
  SUAS_ENV: 'STAGING',
  SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
  SUAS_MIGRATIONS_MODE: 'validate',
  SUAS_EMAIL_MODE: 'sink',
  SUAS_SMS_MODE: 'sink',
  SUAS_TRANSPORTATION_ADAPTER_MODE: 'fake',
  SUAS_SHELTER_ADAPTER_MODE: 'fake',
  SUAS_FOOD_ADAPTER_MODE: 'fake',
  SUAS_PEER_SUPPORT_ADAPTER_MODE: 'manual',
  SUAS_SUPPORT_SIGNAL_MODE: 'fixture',
  SUAS_SAFETY_COPY_MODE: 'placeholder_test_only',
  SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
};

const FORBIDDEN_PUBLIC_SECRET_NAMES =
  /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_).*(?:SECRET|TOKEN|KEY|PASSWORD|DATABASE|RESEND|SERVICE_ROLE)/i;
const FORBIDDEN_STAGING_SECRET_NAMES =
  /^(?:RESEND_API_KEY|.*SERVICE_ROLE.*|.*PROD.*(?:TOKEN|SECRET|KEY).*)$/i;
const PRODUCTION_ENDPOINT_MARKER = /(?:^|[._/-])(pilot|prod|production)(?:[._/-]|$)/i;

export function syntheticStagingContractErrors(
  values: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  const errors: string[] = [];

  for (const [name, expected] of Object.entries(REQUIRED_STAGING_VALUES)) {
    if (values[name] !== expected) errors.push(`${name} must be ${JSON.stringify(expected)}.`);
  }

  for (const name of Object.keys(values)) {
    if (FORBIDDEN_PUBLIC_SECRET_NAMES.test(name)) {
      errors.push(`${name} has a public prefix and a secret-like name.`);
    }
    if (
      FORBIDDEN_STAGING_SECRET_NAMES.test(name) &&
      values[name] !== undefined &&
      values[name] !== ''
    ) {
      errors.push(`${name} must not be configured for synthetic STAGING.`);
    }
    if (
      /_(?:BASE_)?URL$/.test(name) &&
      values[name] !== undefined &&
      PRODUCTION_ENDPOINT_MARKER.test(values[name])
    ) {
      errors.push(`${name} points at a pilot or production-marked endpoint.`);
    }
  }

  return errors;
}

export function assertSyntheticStagingContract(
  values: Readonly<Record<string, string | undefined>>,
): void {
  const errors = syntheticStagingContractErrors(values);
  if (errors.length > 0) {
    throw new Error(`Synthetic STAGING contract failed:\n- ${errors.join('\n- ')}`);
  }
}

function readWranglerVars(configPath: string): Record<string, string | undefined> {
  const source = readFileSync(configPath, 'utf8');
  const values: Record<string, string | undefined> = {};

  for (const match of source.matchAll(/"([A-Z][A-Z0-9_]*)"\s*:\s*"([^"]*)"/g)) {
    values[match[1]!] = match[2];
  }

  for (const name of Object.keys(REQUIRED_STAGING_VALUES)) {
    values[name] ??= undefined;
  }

  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const configPath = resolve(process.cwd(), process.argv[2] ?? 'wrangler.jsonc');
  assertSyntheticStagingContract(readWranglerVars(configPath));
  console.log('Synthetic STAGING contract passed.');
}
