/**
 * Map a Cloudflare Worker isolate's bindings to the SUAS ConfigSource.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §3–§5 (fail-closed configuration; secrets from
 *   platform secret storage)
 * - SUAS-specs ENVIRONMENT.md §6 (secret values never written to logs)
 *
 * Request-path persistence uses the Hyperdrive pooled connection string.
 * The unpooled Neon URL stays with `npm run migrate` on Node and never
 * enters this mapper.
 */

import { ConfigurationError, CONFIG_VARIABLE_NAMES, type ConfigSource } from '../config/index.js';

/** Hyperdrive binding surface used on the Worker request path. */
export interface WorkerHyperdrive {
  readonly connectionString: string;
}

/**
 * Worker bindings. Non-secret values come from wrangler `vars`. Secrets come
 * from `wrangler secret put`. The Hyperdrive binding supplies DATABASE_URL.
 *
 * Do not treat this as a substitute for `wrangler types` after you fill in a
 * real Hyperdrive id; it is the contract this build typechecks against.
 */
export interface WorkerBindings {
  readonly HYPERDRIVE?: WorkerHyperdrive | undefined;
  readonly SUAS_ENV?: string | undefined;
  readonly SUAS_SPEC_VERSION?: string | undefined;
  readonly SUAS_RELEASE_MANIFEST?: string | undefined;
  readonly SUAS_ALLOW_REAL_EXTERNAL_EFFECTS?: string | undefined;
  readonly DATABASE_URL?: string | undefined;
  readonly DATABASE_POOL_MAX?: string | undefined;
  readonly SUAS_MIGRATIONS_MODE?: string | undefined;
  readonly SUAS_SESSION_SECRET?: string | undefined;
  readonly SUAS_EMAIL_MODE?: string | undefined;
  readonly SUAS_SMS_MODE?: string | undefined;
  readonly SUAS_TRANSPORTATION_ADAPTER_MODE?: string | undefined;
  readonly SUAS_SHELTER_ADAPTER_MODE?: string | undefined;
  readonly SUAS_FOOD_ADAPTER_MODE?: string | undefined;
  readonly SUAS_PEER_SUPPORT_ADAPTER_MODE?: string | undefined;
  readonly SUAS_UBER_GUEST_RIDES_CLIENT_ID?: string | undefined;
  readonly SUAS_UBER_GUEST_RIDES_CLIENT_SECRET?: string | undefined;
  readonly SUAS_UBER_GUEST_RIDES_TOKEN_URL?: string | undefined;
  readonly SUAS_UBER_GUEST_RIDES_API_BASE_URL?: string | undefined;
  readonly SUAS_UBER_GUEST_RIDES_WEBHOOK_SECRET?: string | undefined;
  readonly SUAS_AMADEUS_LODGING_CLIENT_ID?: string | undefined;
  readonly SUAS_AMADEUS_LODGING_CLIENT_SECRET?: string | undefined;
  readonly SUAS_AMADEUS_LODGING_TOKEN_URL?: string | undefined;
  readonly SUAS_AMADEUS_LODGING_API_BASE_URL?: string | undefined;
  readonly SUAS_SUPPORT_SIGNAL_MODE?: string | undefined;
  readonly SUAS_SAFETY_COPY_MODE?: string | undefined;
  readonly SUAS_SENSITIVE_AGGREGATE_REPORTING?: string | undefined;
  readonly SUAS_HTTP_PORT?: string | undefined;
  readonly SUAS_HTTP_HOST?: string | undefined;
  readonly SUAS_LOG_LEVEL?: string | undefined;
  readonly SUAS_BUILD_COMMIT?: string | undefined;
  readonly SUAS_BUILD_TIMESTAMP?: string | undefined;
}

function stringBinding(env: WorkerBindings, name: keyof WorkerBindings): string | undefined {
  const value = env[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Build the configuration source for `startApp` from Worker bindings.
 * Throws {@link ConfigurationError} when the isolate cannot serve traffic.
 */
export function configSourceFromWorkerEnv(env: WorkerBindings): ConfigSource {
  const hyperdrive = env.HYPERDRIVE;
  const connectionString = hyperdrive?.connectionString?.trim();
  if (connectionString === undefined || connectionString === '') {
    throw new ConfigurationError([
      'HYPERDRIVE binding is required on the Worker request path. ' +
        'Do not set DATABASE_URL as a Worker secret or var; the pooled ' +
        'connection string comes from the Hyperdrive binding.',
    ]);
  }

  if (env.SUAS_MIGRATIONS_MODE === 'apply') {
    throw new ConfigurationError([
      'Worker runtime rejects SUAS_MIGRATIONS_MODE=apply. Apply migrations ' +
        'with `npm run migrate` against the unpooled URL, then set validate.',
    ]);
  }

  if (env.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS === 'true') {
    throw new ConfigurationError([
      'Worker runtime rejects SUAS_ALLOW_REAL_EXTERNAL_EFFECTS=true ' +
        '(ENVIRONMENT.md §3 rules 3–4).',
    ]);
  }

  const source: Record<string, string | undefined> = {};
  for (const name of CONFIG_VARIABLE_NAMES) {
    if (name === 'DATABASE_URL') continue;
    source[name] = stringBinding(env, name as keyof WorkerBindings);
  }

  // Hyperdrive is the only request-path persistence URL. A DATABASE_URL
  // Worker secret is ignored so an unpooled Neon URL cannot leak onto
  // the isolate's query path.
  source.DATABASE_URL = connectionString;
  source.SUAS_MIGRATIONS_MODE = 'validate';
  source.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS = 'false';
  source.SUAS_BUILD_COMMIT = stringBinding(env, 'SUAS_BUILD_COMMIT');
  source.SUAS_BUILD_TIMESTAMP = stringBinding(env, 'SUAS_BUILD_TIMESTAMP');

  return source;
}
