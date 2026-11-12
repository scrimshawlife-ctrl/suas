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
import { assertExpectedSchemaVersion, createPool, EXPECTED_SCHEMA_VERSION } from './db/index.js';
import {
  createJobQueue,
  DispatchingJobQueue,
  markJobSucceeded,
  type DurableJobQueuePort,
} from './jobs/index.js';
import { createJobHandlers } from './jobs/handlers.js';
import { configureSupportSignalScoring } from './signals/index.js';
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
import { createChannelRegistry } from './notifications/index.js';
import { createModelInferencePort, type ModelInferencePort } from './inference/index.js';
import { createIdVerificationPort, type IdVerificationPort } from './identity/index.js';
import { createChatConnectionLifecycle } from './chat/index.js';
import {
  createConnectionPushPort,
  LocalWebSocketPush,
  type ConnectionPushPort,
} from './realtime/index.js';

export interface StartedApp {
  readonly config: SuasConfig;
  readonly server: FastifyInstance;
  readonly pool: Pool | undefined;
  readonly jobQueue: DurableJobQueuePort;
  readonly challengeDelivery: ChallengeDeliveryPort;
  readonly mfa: MfaPort;
  readonly fulfillmentAdapters: AdapterRegistry;
  readonly modelInference: ModelInferencePort;
  /** Undefined when ID verification is disabled. */
  readonly idVerification: IdVerificationPort | undefined;
  /** Chat live-update push; undefined when SUAS_CHAT_PUSH_MODE=disabled. */
  readonly chatPush: ConnectionPushPort | undefined;
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
    // Worker + Hyperdrive: Client-per-query/request (no cross-request Pool).
    pool = createPool(config, runtime === 'worker' ? 'worker' : 'node');
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

  // 3. Durable async-work seam: Postgres outbox for STAGING/PRODUCTION, a local choice
  // pending D-022 (DECISION_PENDING).
  // LOCAL/TEST keep the in-memory fake unless a pool + override is supplied.
  // CHECKIN_COMPLETED still commits before scoring.
  const innerQueue = createJobQueue(config, {
    ...(pool !== undefined ? { pool } : {}),
    ...(config.environment === 'LOCAL' || config.environment === 'TEST'
      ? { localImplementation: config.localJobQueue }
      : {}),
  });
  // Channel ports are shared by notification.send and authentication delivery.
  const channelRegistry = createChannelRegistry(config);
  // The compute handler enqueues notification.send on the queue that wraps it,
  // so it reads that queue lazily.
  const jobQueue: DurableJobQueuePort =
    pool === undefined
      ? innerQueue
      : new DispatchingJobQueue(
          innerQueue,
          createJobHandlers({
            pool,
            config,
            channels: channelRegistry,
            getJobQueue: () => jobQueue,
          }),
          (error, request) => {
            console.error(`[suas] job ${request.jobType} failed`, error);
          },
          // A handled outbox row is marked done so the job worker skips it.
          innerQueue.implementation === 'postgres-outbox'
            ? (job) => markJobSucceeded(pool, job.jobId)
            : undefined,
        );

  // 4. Authentication capability ports. EMAIL OTP uses the same EmailPort as
  // notifications. D-004 selects Resend only when the released mode is active;
  // fake/sink remain recording-only.
  const challengeDelivery = createChallengeDelivery(config, channelRegistry);
  const mfa = createMfaPort(config);

  // 5. Provider-neutral fulfillment adapter composition. Uber is optional and
  // never displaces the mandatory manual transportation path.
  const fulfillmentAdapters = createFulfillmentAdapterRegistry(config);

  // 5b. Model inference (Intake Assistant, catalog builder). The unavailable port
  // when no model is configured, so callers fall back to the plain form.
  const modelInference = createModelInferencePort(config);
  // 5b. ID scan + selfie capability port (fake adapter only until a provider is chosen).
  const idVerification = createIdVerificationPort(config);
  // 5b. Chat live updates. Messages travel over REST; this only pushes new ones.
  const chatPush =
    pool !== undefined
      ? createConnectionPushPort(config, createChatConnectionLifecycle(pool))
      : undefined;

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
    modelInference,
    ...(idVerification !== undefined ? { idVerification } : {}),
    ...(chatPush !== undefined ? { chatPush } : {}),
    // Pino's default transport uses worker_threads, which Workers do not run.
    ...(runtime === 'worker' ? { logger: false, workerRuntime: true } : {}),
  });

  if (options.listen !== false) {
    const port = options.listenPort ?? (runtime === 'worker' ? 8787 : config.http.port);
    const host = runtime === 'worker' ? '127.0.0.1' : config.http.host;
    await server.listen({ host, port });
    if (chatPush instanceof LocalWebSocketPush) await chatPush.listen(config.chatPush.localPort);
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
    modelInference,
    idVerification,
    chatPush,
    buildInfo: resolveBuildInfo(),
    close: async () => {
      await server.close();
      if (chatPush instanceof LocalWebSocketPush) await chatPush.close();
      if (pool !== undefined) await pool.end();
    },
  };
}
