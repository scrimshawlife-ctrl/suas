/**
 * HTTP surface.
 *
 * Spec citations:
 * - SUAS-specs API.md §2 (`/api/v0` is the sole canonical v0 version selector)
 * - SUAS-specs API.md §4 (authenticated session required unless documented
 *   otherwise; authorization is role + tenant + row + consent/system basis)
 * - SUAS-specs API.md §6 (canonical error body shape)
 * - SUAS-specs API.md §8 / ARCHITECTURE.md §14 (request correlation without PII)
 * - SUAS-specs ENVIRONMENT.md §8 (build-info surface without secrets or veteran PII)
 *
 * Product endpoints arrive with the slices that own them.
 */

import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import type { SuasConfig } from '../config/index.js';
import { API_PREFIX } from '../release/pins.js';
import type { BuildInfo } from '../provenance/build-info.js';
import type { ChallengeDeliveryPort, MfaPort } from '../auth/index.js';
import type { DurableJobQueuePort } from '../jobs/index.js';
import { UnavailableModelInference, type ModelInferencePort } from '../inference/index.js';
import {
  VA_CONFIRMATION_PROJECTION_FIELDS,
  type VeteranConfirmationPort,
} from '../identity/va-confirmation.js';
import type { LicenceReaderPort } from '../identity/licence-reader.js';
import type { ConnectionPushPort } from '../realtime/index.js';
import type { ObjectStoragePort } from '../storage/index.js';
import { assertMfaElevated, assertSuasAdmin } from '../authz/index.js';
import { stagingAccessFromConfig, type StagingAccess } from '../auth/staging-access.js';
import { authenticate } from './authenticate.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminAdapterRoutes } from './routes/admin-adapters.js';
import { registerAdminConsentTemplateRoutes } from './routes/admin-consent-templates.js';
import { registerCaseRoutes } from './routes/cases.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerCheckInRoutes } from './routes/check-ins.js';
import { registerConsentRoutes } from './routes/consents.js';
import { registerContactLogRoutes } from './routes/contact-log.js';
import { registerFollowUpRoutes } from './routes/follow-ups.js';
import { registerIntakeRoutes } from './routes/intake.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerLicenceReviewRoutes } from './routes/licence-reviews.js';
import { registerResourceRoutes } from './routes/resources.js';
import { registerAdminLicenceReviewRoutes } from './routes/admin-licence-reviews.js';
import { registerAdminResourceDraftRoutes } from './routes/admin-resource-drafts.js';
import { registerServiceRequestRoutes } from './routes/service-requests.js';
import { registerTrustedContactRoutes } from './routes/trusted-contacts.js';
import { registerUiRoutes } from './routes/ui.js';
import { registerVeteranRoutes } from './routes/veterans.js';
import { registerVaSandboxOAuthRoutes } from './routes/va-sandbox-oauth.js';
import { registerDevRoutes } from './routes/dev.js';
import { BROWSER_SECURITY_HEADERS, requiresNoStore } from './security-headers.js';
import {
  errorBody,
  frameworkMessage,
  handleClientError,
  handleFrameworkError,
  isMalformedRequestStatus,
  VALIDATION_FAILED,
  validationErrorBody,
} from './error-envelope.js';
import { failureRoute, serializeError, serializeRequest } from './request-logging.js';
import { registerOriginPolicy } from './origin-policy.js';
import { registerNulGuard } from './json-input.js';
import { demoFixedCodeFor } from '../auth/demo-fixed-code.js';

export interface ServerDependencies {
  readonly config: SuasConfig;
  /** Resolved per request so schema version reflects current state. */
  readonly buildInfo: () => BuildInfo;
  /** Persistence. Absent when the process runs without a database. */
  readonly pool?: Pool;
  readonly challengeDelivery?: ChallengeDeliveryPort;
  readonly mfa?: MfaPort;
  readonly jobQueue?: DurableJobQueuePort;
  readonly modelInference?: ModelInferencePort;
  /** VA Veteran Confirmation port; absent when `SUAS_VA_CONFIRMATION_MODE=disabled`. */
  readonly veteranConfirmation?: VeteranConfirmationPort;
  /** Pushes new chat messages to live connections; absent when disabled. */
  readonly chatPush?: ConnectionPushPort;
  /** Licence reader (R10.1, released in 0.10.0); absent when `SUAS_LICENCE_READER_MODE=disabled`. */
  readonly licenceReader?: LicenceReaderPort;
  /** Object storage for licence images; absent when `SUAS_OBJECT_STORAGE_MODE=disabled`. */
  readonly objectStorage?: ObjectStoragePort;
  /** Fastify logger. `false` disables pino (a test that needs no logs). Default keeps the Node structured logger. */
  readonly logger?: boolean;
  /** Where pino writes; stdout when absent. Lets a test inspect what the server logs. */
  readonly logStream?: { write(line: string): void };
}

export interface RegisteredApiRoute {
  readonly method: string;
  readonly path: string;
}

/** Each server's `/api/v0` route list, filled by its own onRoute hook. */
const apiRoutesByServer = new WeakMap<FastifyInstance, readonly RegisteredApiRoute[]>();

/** `/api/v0` routes registered on this server (OpenAPI drift). */
export function listRegisteredApiRoutes(server: FastifyInstance): readonly RegisteredApiRoute[] {
  return [...(apiRoutesByServer.get(server) ?? [])];
}

interface DomainHttpError {
  readonly code: string;
  readonly httpStatus: number;
  readonly retryAfterSeconds?: number;
}

/** Errors that declare a released API error code and HTTP status. API.md §6. */
function asDomainError(error: unknown): DomainHttpError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  // API.md §6: a malformed request body is 400, not an internal failure.
  if (error instanceof ZodError) {
    return { code: VALIDATION_FAILED, httpStatus: 400 };
  }

  const candidate = error as {
    code?: unknown;
    httpStatus?: unknown;
    retryAfterSeconds?: unknown;
  };
  if (typeof candidate.code !== 'string' || typeof candidate.httpStatus !== 'number') {
    return undefined;
  }
  return {
    code: candidate.code,
    httpStatus: candidate.httpStatus,
    ...(typeof candidate.retryAfterSeconds === 'number' &&
    Number.isFinite(candidate.retryAfterSeconds) &&
    candidate.retryAfterSeconds > 0
      ? { retryAfterSeconds: Math.ceil(candidate.retryAfterSeconds) }
      : {}),
  };
}

/** Correlation id, browser security headers, and no-store on every response. */
function applyResponseHeaders(request: FastifyRequest, reply: FastifyReply): void {
  void reply.header('x-request-id', request.id);
  for (const [name, value] of Object.entries(BROWSER_SECURITY_HEADERS)) {
    void reply.header(name, value);
  }
  // A route may only tighten this (the licence images add "private"), never relax it.
  const own = reply.getHeader('cache-control');
  if (requiresNoStore(request.url) && !(typeof own === 'string' && /\bno-store\b/.test(own))) {
    void reply.header('cache-control', 'no-store');
  }
}

export function createServer(deps: ServerDependencies): FastifyInstance {
  const app = Fastify(fastifyOptions(deps));
  const apiRoutes: RegisteredApiRoute[] = [];
  apiRoutesByServer.set(app, apiRoutes);
  const stagingAccess = stagingAccessFromConfig(deps.config);

  // Hooks first: the onRoute hook only sees routes registered after it.
  registerServerHooks(app, stagingAccess, apiRoutes);
  // Unsafe-request origin policy, preflight, and CORS response headers
  // (SUAS-specs D-038, released in 0.7.0). Registered before any route so it covers all of them.
  registerOriginPolicy(app, {
    allowlist: new Set(deps.config.corsAllowedOrigins),
    environment: deps.config.environment,
  });
  // API.md §6: U+0000 in any parsed input is a malformed request on every route.
  registerNulGuard(app);
  registerErrorHandlers(app);

  if (deps.pool !== undefined && deps.config.vaSandboxOAuth.enabled) {
    registerVaSandboxOAuthRoutes(app, {
      pool: deps.pool,
      config: deps.config,
      sessionSecret: deps.config.sessionSecret,
    });
  }
  registerHealthRoute(app, deps);

  const pool = deps.pool;
  if (pool === undefined) return app;
  registerBrowserArea(app, deps, pool);

  const { challengeDelivery, mfa } = deps;
  if (challengeDelivery === undefined || mfa === undefined) return app;
  const area: SignedInArea = { deps, pool, challengeDelivery, mfa, stagingAccess };
  registerSessionArea(app, area);
  registerAdminArea(app, area);
  registerVeteranArea(app, area);
  registerRequestArea(app, area);
  return app;
}

/** Logging, framework refusals and request ids for every server. */
function fastifyOptions(deps: ServerDependencies): FastifyServerOptions {
  return {
    logger:
      deps.logger === false
        ? false
        : {
            level: deps.config.logLevel,
            ...(deps.logStream !== undefined ? { stream: deps.logStream } : {}),
            // ENVIRONMENT.md §6: secret material is never written to logs.
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["idempotency-key"]',
                // suas-specs #72 R9.1 (released in 0.10.0): projection values are never logged.
                ...VA_CONFIRMATION_PROJECTION_FIELDS.flatMap((field) => [
                  `body.${field}`,
                  `req.body.${field}`,
                ]),
                // suas-specs R10.1 (released in 0.10.0): licence images are never logged.
                ...['front', 'back', 'selfie'].flatMap((side) => [
                  `body.${side}`,
                  `req.body.${side}`,
                ]),
              ],
              remove: true,
            },
            // SECURITY.md §2: no query string (OAuth code, dev destination) and no error
            // message or driver detail (pg `detail` quotes row values) in logs.
            serializers: { req: serializeRequest, err: serializeError },
          },
    // Router refusals skip the onSend hook, so they set the common headers themselves.
    frameworkErrors: (error, request, reply) => {
      applyResponseHeaders(request, reply);
      handleFrameworkError(error, request, reply);
    },
    clientErrorHandler: handleClientError,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      const supplied = Array.isArray(header) ? header[0] : header;
      // Correlation identifiers are opaque and carry no veteran PII.
      return supplied !== undefined && /^[A-Za-z0-9._-]{1,128}$/.test(supplied)
        ? supplied
        : randomUUID();
    },
  };
}

/** Staging access on each request, the `/api/v0` route list, and the common response headers. */
function registerServerHooks(
  app: FastifyInstance,
  stagingAccess: StagingAccess,
  apiRoutes: RegisteredApiRoute[],
): void {
  app.addHook('onRequest', (request, _reply, done) => {
    request.stagingAccess = stagingAccess;
    done();
  });

  app.addHook('onRoute', (route) => {
    const path = route.url;
    if (typeof path !== 'string' || !path.startsWith(API_PREFIX)) return;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      const upper = String(method).toUpperCase();
      if (upper === 'HEAD' || upper === 'OPTIONS') continue;
      apiRoutes.push({ method: upper, path });
    }
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    applyResponseHeaders(request, reply);
    done(null, payload);
  });
}

/** API.md §6 canonical error body for unknown routes and thrown errors. */
function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Domain errors carry their own released conflict code and status
    // (API.md §6): for example IDEMPOTENCY_CONFLICT from the idempotency kernel.
    const domain = asDomainError(error);
    const status = domain?.httpStatus ?? error.statusCode ?? 500;

    if (status === 429 && domain?.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(domain.retryAfterSeconds));
    }

    if (status >= 500) {
      request.log.error({ err: error, route: failureRoute(request) }, 'unhandled request failure');
    }

    if (error instanceof ZodError) {
      void reply.status(400).send(validationErrorBody(error));
      return;
    }
    // A Fastify refusal (body too large, bad JSON, wrong media type) gets a fixed message:
    // the parser's own text can quote the body.
    const framework = domain === undefined && error.code?.startsWith('FST_') === true;
    void reply.status(status).send(
      errorBody(
        domain?.code ??
          (isMalformedRequestStatus(status)
            ? VALIDATION_FAILED
            : status >= 500
              ? 'INTERNAL_ERROR'
              : 'REQUEST_FAILED'),
        // Non-sensitive message only; internals are logged, not returned.
        status >= 500
          ? 'Unexpected internal failure.'
          : framework
            ? frameworkMessage(status)
            : error.message,
      ),
    );
  });
}

function registerHealthRoute(app: FastifyInstance, deps: ServerDependencies): void {
  app.get(`${API_PREFIX}/health`, () => {
    // Liveness plus non-secret dependency posture. No provenance secrets,
    // configuration values, or tenant data (ENVIRONMENT.md §8; API.md health).
    return {
      status: 'ok',
      dependencies: {
        database: deps.pool !== undefined ? { status: 'configured' } : { status: 'absent' },
        job_queue:
          deps.jobQueue !== undefined
            ? {
                status: 'configured',
                durability: deps.jobQueue.durability,
                implementation: deps.jobQueue.implementation,
              }
            : { status: 'absent' },
      },
    };
  });
}

/** MVP_REFERENCE.md §5 reference surfaces, mounted under /app rather than the API prefix. */
function registerBrowserArea(app: FastifyInstance, deps: ServerDependencies, pool: Pool): void {
  registerUiRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    config: deps.config,
    safetyCopyMode: deps.config.safetyCopyMode,
    supportSignalMode: deps.config.supportSignalMode,
    ...(deps.challengeDelivery !== undefined ? { challengeDelivery: deps.challengeDelivery } : {}),
    ...(deps.jobQueue !== undefined ? { jobQueue: deps.jobQueue } : {}),
  });
}

/** What the signed-in `/api/v0` areas share: they mount only with a database and auth ports. */
interface SignedInArea {
  readonly deps: ServerDependencies;
  readonly pool: Pool;
  readonly challengeDelivery: ChallengeDeliveryPort;
  readonly mfa: MfaPort;
  readonly stagingAccess: StagingAccess;
}

/** Sign-in, MFA and logout, plus the LOCAL-only developer harness. */
function registerSessionArea(app: FastifyInstance, area: SignedInArea): void {
  const { deps, pool } = area;
  registerAuthRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    delivery: area.challengeDelivery,
    mfa: area.mfa,
    signUpTenantId: deps.config.browserAuth.tenantId,
    // Undefined unless the LOCAL gates pass. Every other path keeps random codes.
    fixedOtpCodeFor: demoFixedCodeFor({
      environment: deps.config.environment,
      demoFixedCode: deps.config.demoFixedCode,
      databaseUrl: deps.config.database.url,
    }),
    stagingAccess: area.stagingAccess,
  });

  // LOCAL-only developer harness for the iOS app (code retrieval + status
  // simulation). Registered only in the synthetic LOCAL environment class and
  // never in TEST/STAGING/PRODUCTION. See routes/dev.ts for the rationale.
  if (deps.config.environment === 'LOCAL') {
    registerDevRoutes(app, {
      pool,
      sessionSecret: deps.config.sessionSecret,
      delivery: area.challengeDelivery,
      modelInference: deps.modelInference,
    });
  }
}

/** SUAS-admin surfaces: build info, adapters, consent templates and Resource drafts. */
function registerAdminArea(app: FastifyInstance, { deps, pool }: SignedInArea): void {
  // ENVIRONMENT.md §8 allows provenance on an admin/debug surface, gated on the
  // SUAS-admin role with an MFA-elevated session (AUTH.md §4; ADMIN.md §2; SECURITY.md §2).
  app.get(`${API_PREFIX}/admin/build-info`, async (request) => {
    const context = await authenticate(pool, deps.config.sessionSecret, request);
    assertSuasAdmin(context);
    assertMfaElevated(context, 'Reading build info');
    return deps.buildInfo();
  });

  registerAdminAdapterRoutes(app, {
    pool,
    config: deps.config,
    sessionSecret: deps.config.sessionSecret,
  });

  registerAdminConsentTemplateRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
  });

  registerAdminResourceDraftRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    modelInference: deps.modelInference ?? new UnavailableModelInference(),
  });
}

/**
 * Check-ins, cases, Resources, Veteran verification and consents. The admin licence-review
 * routes also register here, after the Veteran's own, to keep the original registration order.
 */
function registerVeteranArea(app: FastifyInstance, { deps, pool }: SignedInArea): void {
  registerCheckInRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    ...(deps.jobQueue !== undefined ? { jobQueue: deps.jobQueue } : {}),
  });

  registerCaseRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
  });

  registerResourceRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    safetyCopyMode: deps.config.safetyCopyMode,
  });

  registerVeteranRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    fingerprintKeys: deps.config.fingerprintKeys,
    ...(deps.veteranConfirmation !== undefined
      ? { veteranConfirmation: deps.veteranConfirmation }
      : {}),
  });

  registerLicenceReviewRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    readerConfigured: deps.licenceReader !== undefined,
    ...(deps.objectStorage !== undefined ? { storage: deps.objectStorage } : {}),
    ...(deps.jobQueue !== undefined ? { jobQueue: deps.jobQueue } : {}),
  });

  registerAdminLicenceReviewRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    ...(deps.objectStorage !== undefined ? { storage: deps.objectStorage } : {}),
  });

  registerConsentRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
  });
}

/** Service requests and their chat, trusted contacts, follow-ups, intake, notifications and contact log. */
function registerRequestArea(app: FastifyInstance, { deps, pool }: SignedInArea): void {
  registerServiceRequestRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
  });

  registerChatRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    push: deps.chatPush,
  });

  registerTrustedContactRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
    ...(deps.jobQueue !== undefined ? { jobQueue: deps.jobQueue } : {}),
  });

  registerFollowUpRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
  });

  if (deps.modelInference !== undefined) {
    registerIntakeRoutes(app, {
      pool,
      sessionSecret: deps.config.sessionSecret,
      modelInference: deps.modelInference,
    });
  }

  registerNotificationRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
  });

  registerContactLogRoutes(app, {
    pool,
    sessionSecret: deps.config.sessionSecret,
  });
}
