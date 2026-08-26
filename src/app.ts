/**
 * Application composition and startup sequence.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §5 (configuration validation runs at runtime startup
 *   and fails closed before serving traffic or running workers)
 * - SUAS-specs ENVIRONMENT.md §8 (build provenance surface)
 * - SUAS-specs ENVIRONMENT.md §9 (a build rejects a schema state it cannot safely
 *   operate against)
 * - SUAS-specs HANDOFF.md §3 (foundation order: config validation, migration
 *   harness, durable job abstraction, build provenance)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  ConfigurationError,
  describeConfig,
  loadConfig,
  type ConfigSource,
  type SuasConfig,
} from './config/index.js';
import {
  assertExpectedSchemaVersion,
  createPool,
  EXPECTED_SCHEMA_VERSION,
} from './db/index.js';
import { createJobQueue, DispatchingJobQueue, type DurableJobQueuePort } from './jobs/index.js';
import {
  configureSupportSignalScoring,
  parseComputeJobPayload,
  runSupportSignalComputeJob,
} from './signals/index.js';
import {
  createChallengeDelivery,
  createMfaPort,
  type ChallengeDeliveryPort,
  type MfaPort,
} from './auth/index.js';
import { createServer } from './http/server.js';
import { buildInfo, type BuildInfo } from './provenance/build-info.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from './release/pins.js';
import { createFulfillmentAdapterRegistry, type AdapterRegistry } from './fulfillment/index.js';

export interface StartedApp {
  readonly config: SuasConfig;
  readonly server: FastifyInstance;
  readonly pool: Pool | undefined;
  readonly jobQueue: DurableJobQueuePort;
  readonly challengeDelivery: ChallengeDeliveryPort;
  readonly mfa: MfaPort;
  readonly fulfillmentAdapters: AdapterRegistry;
  readonly buildInfo: BuildInfo;
  close(): Promise<void>;
}

export type AppRuntime = 'node' | 'worker';

export interface StartAppOptions {
  readonly env: ConfigSource;
  /** Skip listening; used by tests that drive the server through inject(). */
  readonly listen?: boolean;
  /**
   * Port for `listen: true`. On Cloudflare's `cloudflare:node` HTTP server
   * path this is a routing key, not a real network port.
   */
  readonly listenPort?: number;
  /**
   * `worker` refuses migration apply and checks only the recorded schema
   * version. Prefer `listen: false` + inject for Node tests; use
   * `listen: true` with `cloudflare:node` `handleAsNodeRequest` on CF.
   * Default `node` keeps the CLI and test path.
   */
  readonly runtime?: AppRuntime;
}

export async function startApp(options: StartAppOptions): Promise<StartedApp> {
  const runtime = options.runtime ?? 'node';
  if (runtime === 'worker' && options.env.SUAS_MIGRATIONS_MODE === 'apply') {
    throw new ConfigurationError([
      'Worker runtime rejects SUAS_MIGRATIONS_MODE=apply. Apply migrations with the Node CLI against the unpooled URL.',
    ]);
  }

  // 1. Configuration validation. Nothing else may run before this succeeds.
  const config = loadConfig(
    runtime === 'worker' ? { ...options.env, SUAS_MIGRATIONS_MODE: 'validate' } : options.env,
  );

  // Pin scoring availability before any job or HTTP handler can run. `disabled`
  // fails closed at computeSignal as well as the job entry (ENVIRONMENT.md §3).
  configureSupportSignalScoring(config.supportSignalMode);

  // 2. Persistence and schema-state validation.
  let pool: Pool | undefined;
  let schemaVersion: number | null = null;

  if (config.database.migrationsMode !== 'off') {
    pool = createPool(config);
    if (runtime === 'worker') {
      // Workers have no on-disk migrations/ tree. SELECT the recorded version
      // only; never apply, never CREATE TABLE (ENVIRONMENT.md §9).
      schemaVersion = await assertExpectedSchemaVersion(pool);
    } else {
      // Dynamic import keeps the Workers bundle from eagerly evaluating the
      // Node-only migration file loader at isolate startup.
      const { runMigrations } = await import('./db/migrator.js');
      const migrationResult = await runMigrations(pool, {
        mode: config.database.migrationsMode,
        provenance: { specVersion: SPEC_VERSION, releaseManifest: RELEASE_MANIFEST },
      });
      schemaVersion = migrationResult.schemaVersion;

      if (migrationResult.specStackDrift) {
        // Reported, not fatal: VERSIONING.md §3 keeps spec stack and schema versions
        // as separate identities.
        console.warn(
          `[suas] schema was created under spec stack ` +
            `${migrationResult.schemaProvenance?.specVersion ?? 'unknown'} but this build pins ${SPEC_VERSION}`,
        );
      }
    }
  }

  // 3. Durable async-work seam. LOCAL/TEST honour enqueued compute jobs in-process
  // while D-022 remains open. CHECKIN_COMPLETED still commits before scoring.
  const innerQueue = createJobQueue(config);
  const jobQueue =
    pool === undefined
      ? innerQueue
      : new DispatchingJobQueue(
          innerQueue,
          {
            'support-signal.compute': async (request) => {
              const parsed = parseComputeJobPayload(request.payload, request.tenantId);
              if (parsed === undefined) return;
              await runSupportSignalComputeJob(pool, config, parsed);
            },
          },
          (error, request) => {
            console.error(`[suas] job ${request.jobType} failed`, error);
          },
        );

  // 4. Authentication capability ports. Neither contacts a real provider: the
  // delivery port reports a disabled channel as unavailable rather than faking a
  // send (AUTH.md §9), and the MFA factor is a test factor that PRODUCTION
  // refuses outright (AUTH.md §4).
  const challengeDelivery = createChallengeDelivery(config);
  const mfa = createMfaPort(config);

  // 5. Provider-neutral fulfillment adapter composition. Uber is optional and
  // never displaces the mandatory manual transportation path.
  const fulfillmentAdapters = createFulfillmentAdapterRegistry(config);

  // 6. Build provenance.
  const resolveBuildInfo = (): BuildInfo =>
    buildInfo({
      config,
      schemaVersion,
      expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
      env: options.env,
    });

  // 7. HTTP surface.
  const server = createServer({
    config,
    buildInfo: resolveBuildInfo,
    ...(pool !== undefined ? { pool } : {}),
    challengeDelivery,
    mfa,
    jobQueue,
    // Pino's default transport uses worker_threads, which Workers do not run.
    ...(runtime === 'worker' ? { logger: false } : {}),
  });

  if (options.listen !== false) {
    const port =
      options.listenPort ??
      (runtime === 'worker' ? 8787 : config.http.port);
    const host = runtime === 'worker' ? '127.0.0.1' : config.http.host;
    await server.listen({ host, port });
    if (runtime !== 'worker') {
      server.log.info(
        { build_info: resolveBuildInfo(), configuration: describeConfig(config) },
        'SUAS started',
      );
    }
  }

  return {
    config,
    server,
    pool,
    jobQueue,
    challengeDelivery,
    mfa,
    fulfillmentAdapters,
    buildInfo: resolveBuildInfo(),
    close: async () => {
      await server.close();
      if (pool !== undefined) await pool.end();
    },
  };
}
