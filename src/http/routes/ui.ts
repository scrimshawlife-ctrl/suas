/**
 * The reference surfaces, served.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §5 (required surface inventory)
 * - SUAS-specs MVP_REFERENCE.md §7.5 (admin scope clearer than the prototype)
 * - SUAS-specs API.md §2 (`/api/v0` is the canonical *API* version selector)
 * - SUAS-specs API.md §4 (session required; tenant and authority are server-derived)
 * - SUAS-specs CHECKINS.md §4 / §6 / §8 (Check-In states, complete, owner-only)
 * - SUAS-specs SAFETY.md §3.2 (settled RED opens or updates a Support Case)
 * - SUAS-specs ADMIN.md §2 / SECURITY.md §2 (privileged surfaces need admin + MFA)
 *
 * These routes are mounted under `/app`, not `/api/v0`: API.md §2 governs the
 * JSON API's version selector, and an HTML surface is not a versioned API
 * resource. The surfaces read the same domain functions the API would. HTML
 * POSTs (deploy, cancel, claim, Check-In start/response/complete) use the
 * same session gate as the GET surfaces.
 *
 * Every handler resolves its own authorization. There is no "UI session" that
 * is weaker than an API session (AUTH.md §5).
 */

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  HookHandlerDoneFunction,
} from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  ChallengeVerificationFailedError,
  issueChallenge,
  revokeSession,
  verifyAndCreateSession,
  type ChallengeDeliveryPort,
} from '../../auth/index.js';
import { assertMfaElevated, assertSuasAdmin, ResourceNotVisibleError } from '../../authz/index.js';
import type { SafetyCopyMode, SupportSignalMode, SuasConfig } from '../../config/index.js';
import { findCurrentCase, SERVICE_CATEGORIES } from '../../coordination/index.js';
import { withTransaction } from '../../db/index.js';
import { appendAuditEvent } from '../../events/index.js';
import {
  RESOURCE_DEFAULT_PAGE_SIZE,
  RESOURCE_MAX_PAGE_SIZE,
  AdapterConfigurationNotFoundError,
  AdapterNotAcceptedError,
  AdapterSecretsMissingError,
  disableAdapterConfiguration,
  enableAdapterConfiguration,
  listAdapterCatalog,
  listAdapterConfigurations,
  searchResources,
  seedManualAdapterConfigurations,
  setAdapterRouting,
} from '../../fulfillment/index.js';
import { ManualAdapterRequiredError } from '../../fulfillment/index.js';
import { requireVerifiedVeteran } from '../../identity/index.js';
import type { DurableJobQueuePort } from '../../jobs/index.js';
import { listGrantsForVeteran, listTrustedCircle } from '../../consent/index.js';
import {
  listChannelPreferences,
  listNotificationsForRecipient,
  NOTIFICATION_CHANNELS,
  setChannelPreference,
} from '../../notifications/index.js';
import {
  completeCheckIn,
  effectiveSignal,
  findCheckIn,
  findInProgressCheckIn,
  listAnsweredQuestionIds,
  listQuestionsWithOptions,
  saveResponse,
  type CheckIn,
} from '../../signals/index.js';
import { presentCheckInResult, startOrResumeCheckIn } from '../../ui/check-in.js';
import { cancelQrf, deployQrf } from '../../ui/commands.js';
import { D_012_APPROVED_SAFETY_COPY } from '../../ui/safety.js';
import {
  CATEGORY_CARDS,
  categoryForCard,
  NonOperationalCategoryError,
  renderAdminOverview,
  renderAdminPlannedSurface,
  renderChat,
  renderCheckInSession,
  renderCheckInStart,
  renderEnrollment,
  renderEmailOtp,
  renderImmediateResources,
  renderLanding,
  renderConsentsList,
  renderNotificationPreferences,
  renderNotificationsInbox,
  renderTrustedContactsList,
  renderResourceCategories,
  renderResourceList,
  renderVeteranHome,
  type ResourceRowViewModel,
  type ShellViewModel,
} from '../../ui/index.js';
import { readActiveQrf } from '../../ui/read.js';
import { authenticate, BROWSER_SESSION_COOKIE } from '../authenticate.js';
import {
  DEMO_FIXED_CODE_DESTINATION,
  demoFixedCodeFor,
  type FixedOtpCodeFor,
} from '../../auth/demo-fixed-code.js';
import { stagingAccessFromConfig } from '../../auth/staging-access.js';
import { normalizeDestination } from '../../auth/secrets.js';

export interface UiRouteDependencies {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly config: SuasConfig;
  /** D-012 safety-copy mode; controls the immediate-resources slot. */
  readonly safetyCopyMode: SafetyCopyMode;
  readonly supportSignalMode: SupportSignalMode;
  readonly jobQueue?: DurableJobQueuePort;
  readonly challengeDelivery?: ChallengeDeliveryPort;
  /** True only when this server is the Cloudflare Worker isolate. */
  readonly workerRuntime?: boolean;
}

function demoSignInFrom(
  fixedOtpCodeFor: FixedOtpCodeFor | undefined,
): { readonly email: string; readonly code: string } | undefined {
  const code = fixedOtpCodeFor?.(DEMO_FIXED_CODE_DESTINATION);
  if (code === undefined) return undefined;
  return { email: DEMO_FIXED_CODE_DESTINATION, code };
}

const HTML = 'text/html; charset=utf-8';
export const BROWSER_AUTH_BODY_LIMIT_BYTES = 4096;

class UnsupportedBrowserFormMediaTypeError extends Error {
  readonly code = 'UNSUPPORTED_MEDIA_TYPE';
  readonly httpStatus = 415;

  constructor() {
    super('Browser authentication accepts HTML form submissions only.');
    this.name = 'UnsupportedBrowserFormMediaTypeError';
  }
}

function assertBrowserFormContentType(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: HookHandlerDoneFunction,
): void {
  const header: unknown = request.headers['content-type'];
  const value =
    typeof header === 'string'
      ? header
      : Array.isArray(header) && typeof header[0] === 'string'
        ? header[0]
        : undefined;
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (mediaType !== 'application/x-www-form-urlencoded') {
    done(new UnsupportedBrowserFormMediaTypeError());
    return;
  }
  done();
}

const BROWSER_AUTH_ROUTE_OPTIONS = {
  bodyLimit: BROWSER_AUTH_BODY_LIMIT_BYTES,
  onRequest: assertBrowserFormContentType,
} as const;

const joinQuery = z.object({
  role: z.enum(['veteran']).optional().default('veteran'),
});
const browserChallengeBody = z.object({
  destination: z.string().email().max(320),
  role: z.enum(['veteran']),
});
const browserVerifyBody = browserChallengeBody.extend({
  code: z.string().min(1).max(512),
});

/**
 * `SameSite` for the `/app` session cookie. Released 0.6.0 (AUTH.md §9.1) is `Strict`.
 * D-038 (AUTH.md §9.3, released in 0.7.0) uses `None` only when a CORS allowlist is
 * configured; with an empty allowlist the cookie can never be used cross-site, so it
 * stays `Strict`.
 */
export function browserCookieSameSite(corsAllowedOrigins: readonly string[]): 'Strict' | 'None' {
  return corsAllowedOrigins.length > 0 ? 'None' : 'Strict';
}

function browserSessionCookie(
  credential: string,
  expiresAt: Date,
  sameSite: 'Strict' | 'None',
): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(credential)}; Max-Age=${maxAge}; Path=/app; Secure; HttpOnly; SameSite=${sameSite}`;
}

function clearBrowserSessionCookie(sameSite: 'Strict' | 'None'): string {
  return `${BROWSER_SESSION_COOKIE}=; Max-Age=0; Path=/app; Secure; HttpOnly; SameSite=${sameSite}`;
}

function shell(title: string, overrides: Partial<ShellViewModel> = {}): ShellViewModel {
  return {
    title,
    viewport: overrides.viewport ?? 'MOBILE',
    showMobileNav: overrides.showMobileNav ?? true,
    ...(overrides.currentNav === undefined ? {} : { currentNav: overrides.currentNav }),
  };
}

/**
 * Fastify params under Cloudflare `handleAsNodeRequest` are sometimes null.
 * Fall back to path segments so `/app/resources/:label` and `/app/.../:id` still work.
 */
function pathParams(
  request: { readonly params?: Record<string, string> | null; readonly url: string },
  kind: 'resource-label' | 'case-id' | 'check-in-id',
): { label?: string; id?: string } {
  const fromRoute = request.params;
  if (fromRoute !== null && fromRoute !== undefined) {
    return fromRoute;
  }
  const path = (request.url.split('?')[0] ?? '').split('/').filter(Boolean);
  if (kind === 'resource-label' && path[0] === 'app' && path[1] === 'resources' && path[2]) {
    return { label: path[2] };
  }
  if (kind === 'case-id') {
    const i = path.indexOf('cases');
    const id = i >= 0 ? path[i + 1] : undefined;
    return id !== undefined ? { id } : {};
  }
  if (kind === 'check-in-id') {
    const i = path.indexOf('check-ins');
    const id = i >= 0 ? path[i + 1] : undefined;
    return id !== undefined ? { id } : {};
  }
  return {};
}
const checkInIdParams = z.object({ id: z.string().uuid() });
const checkInResponseBody = z.object({
  question_id: z.string().uuid(),
  answer_option_id: z.string().uuid(),
});

const coverageCountiesBody = z
  .string()
  .max(4096)
  .transform((value) =>
    value
      .split(',')
      .map((county) => county.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1).max(64)).max(64));

const providerEnableBody = z.object({
  adapter_id: z.string().min(1).max(128),
  coverage_counties: coverageCountiesBody.optional(),
  routing_priority: z.coerce.number().int().min(0).max(10000).optional(),
});

const providerDisableBody = z.object({
  adapter_id: z.string().min(1).max(128),
  capability: z.enum(SERVICE_CATEGORIES),
});

const providerRoutingBody = z.object({
  adapter_id: z.string().min(1).max(128),
  capability: z.enum(SERVICE_CATEGORIES),
  coverage_counties: coverageCountiesBody,
  routing_priority: z.coerce.number().int().min(0).max(10000),
});

const adminProviderFeedback = z.enum([
  'enabled',
  'disabled',
  'routing-saved',
  'credentials-missing',
  'not-accepted',
  'manual-required',
  'not-found',
]);

function providerFeedbackMessage(value: unknown): string | undefined {
  const feedback = adminProviderFeedback.safeParse(value);
  if (!feedback.success) return undefined;
  return {
    enabled: 'Provider enabled for this tenant.',
    disabled: 'Provider disabled for new routing. Existing fulfillment history is unchanged.',
    'routing-saved': 'Provider routing saved.',
    'credentials-missing': 'Provider was not enabled because required credentials are missing.',
    'not-accepted': 'Provider was not changed because it is not accepted in this release.',
    'manual-required': 'The manual fallback is required and cannot be disabled.',
    'not-found': 'That provider configuration was not found for this tenant.',
  }[feedback.data];
}

function providerFailureFeedback(error: unknown): string | undefined {
  if (error instanceof AdapterSecretsMissingError) return 'credentials-missing';
  if (error instanceof AdapterNotAcceptedError) return 'not-accepted';
  if (error instanceof ManualAdapterRequiredError) return 'manual-required';
  if (error instanceof AdapterConfigurationNotFoundError) return 'not-found';
  return undefined;
}

function parseFormBody(body: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) {
    parsed[key] = value;
  }
  return parsed;
}

function registerHtmlFormParser(app: FastifyInstance): void {
  if (app.hasContentTypeParser('application/x-www-form-urlencoded')) return;
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request: FastifyRequest, body: string, done) => {
      try {
        done(null, parseFormBody(body));
      } catch (error) {
        done(error instanceof Error ? error : new Error('Invalid form body.'), undefined);
      }
    },
  );
}

async function loadOwnedCheckIn(
  pool: Pool,
  tenantId: string,
  userId: string,
  checkInId: string,
): Promise<CheckIn> {
  const checkIn = await findCheckIn(pool, tenantId, checkInId);
  if (checkIn === undefined || checkIn.veteranUserId !== userId) {
    throw new ResourceNotVisibleError();
  }
  return checkIn;
}

export function registerUiRoutes(app: FastifyInstance, deps: UiRouteDependencies): void {
  const { config, pool, sessionSecret, safetyCopyMode, supportSignalMode } = deps;
  const stagingAccess = stagingAccessFromConfig(config);
  const fixedOtpCodeFor = demoFixedCodeFor({
    environment: config.environment,
    demoFixedCode: config.demoFixedCode,
    databaseUrl: config.database.url,
    workerRuntime: deps.workerRuntime === true,
  });
  const demoSignIn = demoSignInFrom(fixedOtpCodeFor);
  registerHtmlFormParser(app);

  const adminContext = async (request: Parameters<typeof authenticate>[2], reason: string) => {
    const context = await authenticate(pool, sessionSecret, request);
    assertSuasAdmin(context);
    assertMfaElevated(context, reason);
    return context;
  };

  // --- Public surfaces -------------------------------------------------------
  // §5 lists these as public: a veteran must be able to see the action surface
  // before holding a session.

  app.get('/', async (_request, reply) => {
    await reply.redirect('/app');
  });

  app.get('/app', async (_request, reply) => {
    await reply.type(HTML).send(
      renderLanding({
        shell: shell('Shut Up and Serve', { showMobileNav: false }),
        // §7.4: mission framing with no statistic or clinical efficacy claim.
        missionLine: 'Veteran peer support, coordinated by people who served.',
        ...(demoSignIn === undefined ? {} : { demoSignIn }),
      }),
    );
  });

  app.get('/app/join', async (request, reply) => {
    const query = joinQuery.parse(request.query ?? {});
    await reply.type(HTML).send(
      renderEnrollment({
        shell: shell('Join the Mission', { showMobileNav: false }),
        authEnabled: config.browserAuth.mode === 'email_otp',
        selectedRole: query.role,
        contactChannelRequirement:
          'Use the email address already enrolled for this environment. We send a sign-in code; this does not create a new account.',
        ...(demoSignIn === undefined ? {} : { demoSignIn }),
      }),
    );
  });

  app.post('/app/auth/challenges', BROWSER_AUTH_ROUTE_OPTIONS, async (request, reply) => {
    const body = browserChallengeBody.parse(request.body);
    const tenantId = config.browserAuth.tenantId;
    if (
      config.browserAuth.mode !== 'email_otp' ||
      tenantId === undefined ||
      deps.challengeDelivery === undefined
    ) {
      return reply
        .status(503)
        .type(HTML)
        .send(
          renderEnrollment({
            shell: shell('Join the Mission', { showMobileNav: false }),
            authEnabled: false,
            selectedRole: body.role,
            contactChannelRequirement: 'Email sign-in is not available in this environment.',
          }),
        );
    }

    await issueChallenge(
      {
        pool,
        sessionSecret,
        delivery: deps.challengeDelivery,
        fixedOtpCodeFor,
        stagingAccess,
      },
      {
        tenantId,
        destination: body.destination,
        method: 'EMAIL_OTP',
        correlationId: String(request.id),
      },
    );

    const showDemoCode =
      demoSignIn !== undefined &&
      normalizeDestination(body.destination) === DEMO_FIXED_CODE_DESTINATION;
    return reply.type(HTML).send(
      renderEmailOtp({
        shell: shell('Check your email', { showMobileNav: false }),
        destination: body.destination,
        selectedRole: body.role,
        ...(showDemoCode ? { demoCode: demoSignIn.code } : {}),
      }),
    );
  });

  app.post('/app/auth/verify', BROWSER_AUTH_ROUTE_OPTIONS, async (request, reply) => {
    const body = browserVerifyBody.parse(request.body);
    const tenantId = config.browserAuth.tenantId;
    if (
      config.browserAuth.mode !== 'email_otp' ||
      tenantId === undefined ||
      deps.challengeDelivery === undefined
    ) {
      return reply
        .status(503)
        .type(HTML)
        .send(
          renderEmailOtp({
            shell: shell('Check your email', { showMobileNav: false }),
            destination: body.destination,
            selectedRole: body.role,
            error: 'Email sign-in is not available in this environment.',
          }),
        );
    }

    try {
      const issued = await verifyAndCreateSession(
        { pool, sessionSecret, delivery: deps.challengeDelivery, fixedOtpCodeFor, stagingAccess },
        {
          tenantId,
          destination: body.destination,
          code: body.code,
          correlationId: String(request.id),
        },
      );
      void reply.header(
        'set-cookie',
        browserSessionCookie(
          issued.credential,
          issued.session.expiresAt,
          browserCookieSameSite(config.corsAllowedOrigins),
        ),
      );
      return reply.redirect('/app/home', 303);
    } catch (error: unknown) {
      if (!(error instanceof ChallengeVerificationFailedError)) throw error;
      return reply
        .status(401)
        .type(HTML)
        .send(
          renderEmailOtp({
            shell: shell('Check your email', { showMobileNav: false }),
            destination: body.destination,
            selectedRole: body.role,
            error: 'The sign-in code is invalid or has expired.',
            ...(demoSignIn !== undefined &&
            normalizeDestination(body.destination) === DEMO_FIXED_CODE_DESTINATION
              ? { demoCode: demoSignIn.code }
              : {}),
          }),
        );
    }
  });

  app.post('/app/auth/logout', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await withTransaction(pool, async (tx) => {
      await revokeSession(tx, context.session.sessionId, 'LOGOUT');
      await appendAuditEvent(tx, {
        eventType: 'AUTH_SESSION_INVALIDATED',
        action: 'REVOKE_SESSION',
        targetType: 'Session',
        targetId: context.session.sessionId,
        aggregateType: 'User',
        aggregateId: context.userId,
        tenantId: context.tenantId,
        actorType: 'SYSTEM',
        actorId: context.userId,
        payload: { scope: 'CURRENT', channel: 'BROWSER' },
        correlationId: String(request.id),
      });
    });
    void reply.header(
      'set-cookie',
      clearBrowserSessionCookie(browserCookieSameSite(config.corsAllowedOrigins)),
    );
    return reply.redirect('/app', 303);
  });

  // --- Veteran surfaces ------------------------------------------------------

  app.get('/app/home', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    // The legacy page's card and its Cancel button are about the peer-support request.
    const active = await readActiveQrf(pool, context.tenantId, context.userId, {
      category: 'PEER_SUPPORT',
    });
    const inProgress = await findInProgressCheckIn(pool, context.tenantId, context.userId);

    await reply.type(HTML).send(
      renderVeteranHome({
        shell: shell('Support', { currentNav: 'HOME' }),
        categories: CATEGORY_CARDS,
        safetyCopyMode,
        checkInLink: {
          href:
            inProgress === undefined ? '/app/check-ins' : `/app/check-ins/${inProgress.checkInId}`,
          label: inProgress === undefined ? 'Start a Check-In' : 'Continue Check-In',
        },
        notificationsHref: '/app/notifications',
        consentsHref: '/app/consents',
        trustedContactsHref: '/app/trusted-contacts',
        ...(active === undefined
          ? {}
          : {
              activeQrf: {
                facts: active.facts,
                // Contact paths require a consent evaluation against a known
                // counterpart. Until a request is accepted there is no
                // counterpart, so no path is asserted here (§7.2).
                // `/app/qrf/call` and `/app/qrf/message` have no handler.
                authorizedVoicePath: false,
                authorizedMessagePath: false,
              },
            }),
      }),
    );
  });

  const notificationsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
  });

  app.get('/app/notifications', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const query = notificationsQuery.parse(request.query ?? {});
    const page = await listNotificationsForRecipient(
      pool,
      context.tenantId,
      context.userId,
      query.limit,
    );
    await reply.type(HTML).send(
      renderNotificationsInbox({
        shell: shell('Notifications'),
        limit: query.limit,
        preferencesHref: '/app/notifications/preferences',
        notifications: page.map((notification) => ({
          reason: notification.reason,
          channel: notification.channel,
          deliveryStatus: notification.deliveryStatus,
          attemptCount: notification.attemptCount,
          ...(notification.sentAt !== undefined
            ? { sentAtLabel: notification.sentAt.toISOString() }
            : {}),
          ...(notification.subjectType !== undefined
            ? { subjectType: notification.subjectType }
            : {}),
        })),
      }),
    );
  });

  app.get('/app/notifications/preferences', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const preferences = await listChannelPreferences(pool, context.tenantId, context.userId);
    await reply.type(HTML).send(
      renderNotificationPreferences({
        shell: shell('Channel preferences'),
        preferences: preferences.map((pref) => ({
          channel: pref.channel,
          enabled: pref.enabled,
        })),
      }),
    );
  });

  const preferenceBody = z.object({
    channel: z.enum(NOTIFICATION_CHANNELS),
    enabled: z.enum(['true', 'false']),
  });

  app.post('/app/notifications/preferences', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const body = preferenceBody.parse(request.body ?? {});
    await setChannelPreference(pool, {
      tenantId: context.tenantId,
      userId: context.userId,
      channel: body.channel,
      enabled: body.enabled === 'true',
    });
    return reply.redirect('/app/notifications/preferences', 303);
  });

  app.get('/app/consents', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    const grants = await listGrantsForVeteran(pool, context.tenantId, context.userId);
    await reply.type(HTML).send(
      renderConsentsList({
        shell: shell('Consents'),
        grants: grants.map((grant) => ({
          permission: grant.permission,
          scope: grant.scope,
          purpose: grant.purpose,
          granteeType: grant.granteeType,
          status: grant.status,
          grantedAtLabel: grant.grantedAt.toISOString(),
          ...(grant.expiresAt !== undefined
            ? { expiresAtLabel: grant.expiresAt.toISOString() }
            : {}),
        })),
      }),
    );
  });

  app.get('/app/trusted-contacts', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    const contacts = await listTrustedCircle(pool, context.tenantId, context.userId);
    await reply.type(HTML).send(
      renderTrustedContactsList({
        shell: shell('Trusted contacts'),
        contacts: contacts.map((contact) => ({
          relationshipLabel: contact.relationshipLabel,
          status: contact.status,
        })),
      }),
    );
  });

  app.post('/app/qrf/deploy', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    await deployQrf(pool, {
      tenantId: context.tenantId,
      veteranUserId: context.userId,
      correlationId: String(request.id),
    });
    return reply.redirect('/app/home', 303);
  });

  app.post('/app/qrf/cancel', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await cancelQrf(pool, {
      tenantId: context.tenantId,
      veteranUserId: context.userId,
      correlationId: String(request.id),
    });
    return reply.redirect('/app/home', 303);
  });

  app.get('/app/check-ins', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    const inProgress = await findInProgressCheckIn(pool, context.tenantId, context.userId);
    await reply.type(HTML).send(
      renderCheckInStart({
        shell: shell('Check-In'),
        supportSignalMode,
        ...(inProgress === undefined
          ? {}
          : { inProgressHref: `/app/check-ins/${inProgress.checkInId}` }),
      }),
    );
  });

  app.post('/app/check-ins', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    const started = await startOrResumeCheckIn(pool, {
      tenantId: context.tenantId,
      veteranUserId: context.userId,
    });
    return reply.redirect(`/app/check-ins/${started.checkIn.checkInId}`, 303);
  });

  app.get<{ Params: { id: string } }>('/app/check-ins/:id', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    const { id } = checkInIdParams.parse(pathParams(request, 'check-in-id'));
    const checkIn = await loadOwnedCheckIn(pool, context.tenantId, context.userId, id);
    const questions = await listQuestionsWithOptions(pool, checkIn.questionnaireVersion);
    const answered = new Set(await listAnsweredQuestionIds(pool, checkIn.checkInId));
    const nextIndex = questions.findIndex((question) => !answered.has(question.questionId));
    const nextQuestion = nextIndex === -1 ? undefined : questions[nextIndex];
    const settled =
      checkIn.status === 'COMPLETED' ||
      checkIn.status === 'INCOMPLETE' ||
      checkIn.status === 'ABANDONED';
    const signal = settled
      ? await effectiveSignal(pool, context.tenantId, context.userId)
      : undefined;
    const supportCase =
      signal?.level === 'RED'
        ? await findCurrentCase(pool, context.tenantId, context.userId)
        : undefined;

    await reply.type(HTML).send(
      renderCheckInSession({
        shell: shell('Check-In'),
        checkInId: checkIn.checkInId,
        status: checkIn.status,
        questionnaireVersion: checkIn.questionnaireVersion,
        canComplete: checkIn.status === 'STARTED' || checkIn.status === 'IN_PROGRESS',
        ...(nextQuestion === undefined || settled
          ? {}
          : {
              questionIndex: nextIndex + 1,
              questionCount: questions.length,
              currentQuestion: {
                questionId: nextQuestion.questionId,
                prompt: nextQuestion.prompt,
                required: nextQuestion.required,
                options: nextQuestion.options.map((option) => ({
                  answerOptionId: option.answerOptionId,
                  label: option.label,
                })),
              },
            }),
        ...(settled
          ? {
              result: presentCheckInResult({
                status: checkIn.status,
                supportSignalMode,
                supportCaseOpened: supportCase !== undefined,
                ...(signal === undefined ? {} : { signalLevel: signal.level }),
              }),
            }
          : {}),
      }),
    );
  });

  app.post<{ Params: { id: string } }>('/app/check-ins/:id/responses', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    const { id } = checkInIdParams.parse(pathParams(request, 'check-in-id'));
    await loadOwnedCheckIn(pool, context.tenantId, context.userId, id);
    const body = checkInResponseBody.parse(request.body);
    await saveResponse(pool, {
      tenantId: context.tenantId,
      checkInId: id,
      questionId: body.question_id,
      answerOptionId: body.answer_option_id,
    });
    return reply.redirect(`/app/check-ins/${id}`, 303);
  });

  app.post<{ Params: { id: string } }>(
    '/app/check-ins/:id/commands/complete',
    async (request, reply) => {
      const context = await authenticate(pool, sessionSecret, request);
      await requireVerifiedVeteran(pool, context);
      const { id } = checkInIdParams.parse(pathParams(request, 'check-in-id'));
      await loadOwnedCheckIn(pool, context.tenantId, context.userId, id);
      await completeCheckIn(
        pool,
        {
          tenantId: context.tenantId,
          checkInId: id,
          actorId: context.userId,
          correlationId: String(request.id),
        },
        deps.jobQueue !== undefined ? { jobQueue: deps.jobQueue } : {},
      );
      return reply.redirect(`/app/check-ins/${id}`, 303);
    },
  );

  // The crisis screen is for everyone, signed out or unverified (plan §2.1).
  app.get('/app/immediate-resources', async (_request, reply) => {
    await reply
      .type(HTML)
      .send(renderImmediateResources(shell('Immediate Resources'), safetyCopyMode));
  });

  // API.md §5: HTML list pages accept the same cursor/limit bounds as /api/v0.
  const resourceListQuery = z.object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(RESOURCE_MAX_PAGE_SIZE)
      .default(RESOURCE_DEFAULT_PAGE_SIZE),
  });
  app.get('/app/resources', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    await reply
      .type(HTML)
      .send(renderResourceCategories({ shell: shell('Find help'), categories: CATEGORY_CARDS }));
  });

  app.get<{ Params: { label: string } }>('/app/resources/:label', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    await requireVerifiedVeteran(pool, context);
    const { label } = pathParams(request, 'resource-label');
    if (label === undefined || label === '') {
      throw new NonOperationalCategoryError('(missing)', 'COMING_SOON');
    }

    const card = CATEGORY_CARDS.find(
      (entry) => entry.label.toLowerCase().replace(/ /g, '-') === label,
    );
    if (card === undefined) {
      throw new NonOperationalCategoryError(label, 'COMING_SOON');
    }

    // §6: a non-operational card renders its information state and never
    // reaches the catalog as if it were a released category.
    if (card.disposition !== 'OPERATIONAL') {
      await reply.type(HTML).send(
        renderResourceList({
          shell: shell(card.label),
          categoryLabel: card.label,
          backHref: '/app/resources',
          rows: [],
        }),
      );
      return;
    }

    const category = categoryForCard(card.label);
    // handleAsNodeRequest may yield a null query object; coerce before Zod.
    const query = resourceListQuery.parse(request.query ?? {});
    const page = await searchResources(
      pool,
      context.tenantId,
      {
        category,
        activeOnly: true,
      },
      {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
    );

    const rows: ResourceRowViewModel[] = page.results.map((result) => ({
      id: result.resource.resourceId,
      name: result.resource.serviceName,
      freshness: result.freshness,
      staleWarning: result.staleWarning,
      ...(result.resource.counties.length > 0
        ? { coverage: result.resource.counties.join(', ') }
        : {}),
      ...(result.resource.contactMethod === undefined
        ? {}
        : { contactMethod: result.resource.contactMethod }),
      ...(result.resource.contactMethodKind === undefined
        ? {}
        : { contactMethodKind: result.resource.contactMethodKind }),
      ...(result.resource.hours === undefined ? {} : { hours: result.resource.hours }),
      ...(result.resource.cost === undefined ? {} : { cost: result.resource.cost }),
    }));

    await reply.type(HTML).send(
      renderResourceList({
        shell: shell(card.label),
        categoryLabel: card.label,
        backHref: '/app/resources',
        rows,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      }),
    );
  });

  app.get('/app/chat', async (request, reply) => {
    await authenticate(pool, sessionSecret, request);

    // §5 requires a persistent Chat entry, and no released slice implements a
    // message thread store. The surface exists and states its unavailability
    // rather than rendering an empty inbox that implies messaging works.
    await reply.type(HTML).send(
      renderChat({
        shell: shell('Chat', { currentNav: 'CHAT' }),
        availability: {
          status: 'UNAVAILABLE',
          reason:
            'Messaging is not available yet. The person who accepts your request will contact you through ' +
            'the channels you have consented to.',
        },
      }),
    );
  });

  // --- Admin surface ---------------------------------------------------------

  app.post('/app/admin/providers/enable', async (request, reply) => {
    const context = await adminContext(request, 'Enabling provider adapter');
    const body = providerEnableBody.parse(request.body ?? {});
    const entry = listAdapterCatalog(config).find(
      (candidate) => candidate.adapterId === body.adapter_id,
    );
    if (entry === undefined) throw new AdapterNotAcceptedError(body.adapter_id, 'provider');

    try {
      await enableAdapterConfiguration(pool, config, {
        tenantId: context.tenantId,
        adapterId: entry.adapterId,
        capability: entry.capability,
        actorId: context.userId,
        ...(body.coverage_counties !== undefined
          ? { coverageCounties: body.coverage_counties }
          : {}),
        ...(body.routing_priority !== undefined ? { routingPriority: body.routing_priority } : {}),
        correlationId: String(request.id),
      });
    } catch (error) {
      const feedback = providerFailureFeedback(error);
      if (feedback !== undefined) return reply.redirect(`/app/admin?provider=${feedback}`, 303);
      throw error;
    }
    return reply.redirect('/app/admin?provider=enabled', 303);
  });

  app.post('/app/admin/providers/disable', async (request, reply) => {
    const context = await adminContext(request, 'Disabling provider adapter');
    const body = providerDisableBody.parse(request.body ?? {});

    try {
      await disableAdapterConfiguration(pool, config, {
        tenantId: context.tenantId,
        adapterId: body.adapter_id,
        capability: body.capability,
        actorId: context.userId,
        correlationId: String(request.id),
      });
    } catch (error) {
      const feedback = providerFailureFeedback(error);
      if (feedback !== undefined) return reply.redirect(`/app/admin?provider=${feedback}`, 303);
      throw error;
    }
    return reply.redirect('/app/admin?provider=disabled', 303);
  });

  app.post('/app/admin/providers/routing', async (request, reply) => {
    const context = await adminContext(request, 'Changing provider routing');
    const body = providerRoutingBody.parse(request.body ?? {});

    try {
      await setAdapterRouting(pool, config, {
        tenantId: context.tenantId,
        adapterId: body.adapter_id,
        capability: body.capability,
        actorId: context.userId,
        coverageCounties: body.coverage_counties,
        routingPriority: body.routing_priority,
        correlationId: String(request.id),
      });
    } catch (error) {
      const feedback = providerFailureFeedback(error);
      if (feedback !== undefined) return reply.redirect(`/app/admin?provider=${feedback}`, 303);
      throw error;
    }
    return reply.redirect('/app/admin?provider=routing-saved', 303);
  });

  const plannedAdminRoutes = [
    ['/app/admin/access', 'Access'],
    ['/app/admin/artifacts', 'Published artifacts'],
    ['/app/admin/providers', 'Provider adapters'],
    ['/app/admin/operations', 'Platform operations'],
    ['/app/admin/audit', 'Audit explorer'],
  ] as const;
  for (const [path, title] of plannedAdminRoutes) {
    app.get(path, async (request, reply) => {
      const context = await adminContext(request, `Viewing ${title}`);
      return reply
        .status(501)
        .type(HTML)
        .send(
          renderAdminPlannedSurface({
            shell: shell('SUAS Admin', { viewport: 'DESKTOP', showMobileNav: false }),
            title,
            scope: context.tenantId,
            reason:
              'This module remains disabled until its released API, authorization, and audit contract is available.',
            backHref: '/app/admin',
          }),
        );
    });
  }

  app.get('/app/admin', async (request, reply) => {
    const context = await adminContext(request, 'Viewing the admin overview');
    const query = z
      .object({ provider: adminProviderFeedback.optional() })
      .parse(request.query ?? {});
    await seedManualAdapterConfigurations(pool, context.tenantId);
    const catalog = listAdapterCatalog(config);
    const configurations = await listAdapterConfigurations(pool, config, context.tenantId);
    const notice = providerFeedbackMessage(query.provider);

    await reply.type(HTML).send(
      renderAdminOverview({
        shell: shell('SUAS Admin', { viewport: 'DESKTOP', showMobileNav: false }),
        tenantLabel: context.tenantId,
        ...(notice === undefined ? {} : { notice }),
        providerCatalog: catalog.map((provider) => ({
          adapterId: provider.adapterId,
          capability: provider.capability,
          integrationMode: provider.integrationMode,
          decision: provider.decision,
          label: provider.label,
          secretPresence: provider.secretPresence,
        })),
        providerConfigurations: configurations.map((provider) => ({
          adapterConfigurationId: provider.adapterConfigurationId,
          adapterId: provider.adapterId,
          capability: provider.capability,
          integrationMode: provider.integrationMode,
          enabled: provider.enabled,
          routingPriority: provider.routingPriority,
          health: provider.health,
          coverageCounties: provider.coverageCounties,
          secretPresence: provider.secretPresence,
          label: provider.catalogLabel,
        })),
        // Presence only. ARCHITECTURE.md forbids credential values on any
        // domain or admin surface.
        capabilities: [
          { name: 'Peer support (manual)', presence: 'CONFIGURED' },
          {
            name: 'Provider disclosure projections',
            presence: 'MISSING',
            note: 'no released contracts',
          },
          {
            name: 'Support signal scoring',
            presence: 'MISSING',
            note: 'D-011 released sv-001; SUAS_SUPPORT_SIGNAL_MODE stays fixture/disabled',
          },
          {
            name: 'Approved safety copy',
            presence: safetyCopyMode === 'approved' ? 'CONFIGURED' : 'MISSING',
            note:
              safetyCopyMode === 'approved'
                ? `D-012 ${D_012_APPROVED_SAFETY_COPY}; SUAS_SAFETY_COPY_MODE=approved`
                : `D-012 ${D_012_APPROVED_SAFETY_COPY}; SUAS_SAFETY_COPY_MODE=${safetyCopyMode}`,
          },
        ],
        blockingDecisions: ['D-017 to D-020 production provider adapters'],
        readiness: 'SPEC-017 implementation. Not authorized for pilot or production operation.',
      }),
    );
  });
}
