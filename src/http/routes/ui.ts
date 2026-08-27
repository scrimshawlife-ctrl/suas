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

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  assertMfaElevated,
  assertResponder,
  assertSuasAdmin,
  ResourceNotVisibleError,
} from '../../authz/index.js';
import type { SafetyCopyMode, SupportSignalMode } from '../../config/index.js';
import {
  CaseAlreadyClaimedError,
  CaseNotFoundError,
  claimCase,
  ClosedCaseError,
  CONTACT_CHANNELS,
  CONTACT_OUTCOMES,
  createServiceRequest,
  DEFAULT_PAGE_SIZE,
  findActiveAssignment,
  findCase,
  findNonClosedCase,
  IllegalCaseTransitionError,
  listCaseServiceRequests,
  listContactAttempts,
  MAX_PAGE_SIZE,
  NoActiveAssignmentError,
  readCaseQueue,
  recordContact,
  SERVICE_CATEGORIES,
} from '../../coordination/index.js';
import { withTransaction } from '../../db/index.js';
import {
  RESOURCE_DEFAULT_PAGE_SIZE,
  RESOURCE_MAX_PAGE_SIZE,
  searchResources,
} from '../../fulfillment/index.js';
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
  DUTY_UNAVAILABLE_REASON,
  categoryForCard,
  NonOperationalCategoryError,
  renderActiveNeeds,
  renderAdminOverview,
  renderChat,
  renderCheckInSession,
  renderCheckInStart,
  renderEnrollment,
  renderImmediateResources,
  renderLanding,
  renderConsentsList,
  renderNotificationPreferences,
  renderNotificationsInbox,
  renderTrustedContactsList,
  renderResourceCategories,
  renderResourceList,
  renderResponderAvailability,
  renderResponderCase,
  renderResponderDashboard,
  renderVeteranHome,
  type ActiveNeedViewModel,
  type ResourceRowViewModel,
  type ShellViewModel,
} from '../../ui/index.js';
import { readActiveQrf } from '../../ui/read.js';
import { authenticate } from '../authenticate.js';

export interface UiRouteDependencies {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  /** D-012 safety-copy mode; controls the immediate-resources slot. */
  readonly safetyCopyMode: SafetyCopyMode;
  readonly supportSignalMode: SupportSignalMode;
  readonly jobQueue?: DurableJobQueuePort;
}

const HTML = 'text/html; charset=utf-8';

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
  const { pool, sessionSecret, safetyCopyMode, supportSignalMode } = deps;
  registerHtmlFormParser(app);

  // --- Public surfaces -------------------------------------------------------
  // §5 lists these as public: a veteran must be able to see the action surface
  // before holding a session.

  app.get('/app', async (_request, reply) => {
    await reply.type(HTML).send(
      renderLanding({
        shell: shell('Shut Up and Serve', { showMobileNav: false }),
        // §7.4: mission framing with no statistic or clinical efficacy claim.
        missionLine: 'Veteran peer support, coordinated by people who served.',
      }),
    );
  });

  app.get('/app/join', async (_request, reply) => {
    // Display-only. AUTH.md challenge issue/verify exist on `/api/v0/auth`, but
    // HTML join cannot resolve tenant (Slice 3 gap), cannot enroll a new User,
    // and cannot persist a Bearer session. See SLICE_10_UI_COMMANDS.md §4.
    await reply.type(HTML).send(
      renderEnrollment({
        shell: shell('Join the Mission', { showMobileNav: false }),
        // §7.1: the reference's "No email" promise contradicts AUTH.md.
        contactChannelRequirement:
          'We need an email address or mobile number to send your sign-in code.',
      }),
    );
  });

  // --- Veteran surfaces ------------------------------------------------------

  app.get('/app/home', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const active = await readActiveQrf(pool, context.tenantId, context.userId);
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
    const started = await startOrResumeCheckIn(pool, {
      tenantId: context.tenantId,
      veteranUserId: context.userId,
    });
    return reply.redirect(`/app/check-ins/${started.checkIn.checkInId}`, 303);
  });

  app.get<{ Params: { id: string } }>('/app/check-ins/:id', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
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
        ? await findNonClosedCase(pool, context.tenantId, context.userId)
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

  app.get('/app/immediate-resources', async (request, reply) => {
    await authenticate(pool, sessionSecret, request);
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
  const responderQueueQuery = z.object({
    unassigned_cursor: z.string().min(1).max(512).optional(),
    active_cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  });
  const activeNeedsQuery = z.object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  });

  app.get('/app/resources', async (request, reply) => {
    await authenticate(pool, sessionSecret, request);
    await reply
      .type(HTML)
      .send(renderResourceCategories({ shell: shell('Find help'), categories: CATEGORY_CARDS }));
  });

  app.get<{ Params: { label: string } }>('/app/resources/:label', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
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
            'Messaging is not available yet. Your responder will contact you through ' +
            'the channels you have consented to.',
        },
      }),
    );
  });

  // --- Responder surfaces ----------------------------------------------------

  function toNeed(
    supportCase: {
      caseId: string;
      status: string;
      prioritySignalLevel?: string | undefined;
    },
    claimable: boolean,
  ): ActiveNeedViewModel {
    return {
      caseId: supportCase.caseId,
      caseStatus: supportCase.status,
      category: 'Support Case',
      openedLabel: 'Opened',
      ...(supportCase.prioritySignalLevel !== undefined
        ? { prioritySignalLevel: supportCase.prioritySignalLevel }
        : {}),
      ...(claimable ? { claimable: true } : {}),
    };
  }

  app.get('/app/responder', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const query = responderQueueQuery.parse(request.query ?? {});
    const isResponder = context.memberships.some((membership) => membership.role === 'RESPONDER');
    const unassigned = isResponder
      ? await readCaseQueue(
          pool,
          context.tenantId,
          { ownership: 'unassigned' },
          {
            limit: query.limit,
            ...(query.unassigned_cursor !== undefined ? { cursor: query.unassigned_cursor } : {}),
          },
        )
      : { cases: [], nextCursor: undefined };
    const mine = isResponder
      ? await readCaseQueue(
          pool,
          context.tenantId,
          { ownership: 'mine', responderUserId: context.userId },
          {
            limit: query.limit,
            ...(query.active_cursor !== undefined ? { cursor: query.active_cursor } : {}),
          },
        )
      : { cases: [], nextCursor: undefined };

    await reply.type(HTML).send(
      renderResponderDashboard({
        shell: shell('Responder', { viewport: 'DESKTOP' }),
        // G-I-30: on-duty is not a recorded fact. State unavailability rather
        // than inventing a roster or posting a no-op that would look like a write.
        duty: { status: 'UNAVAILABLE', reason: DUTY_UNAVAILABLE_REASON },
        unassignedNeeds: unassigned.cases.map((supportCase) => toNeed(supportCase, true)),
        ...(unassigned.nextCursor !== undefined
          ? { unassignedNextCursor: unassigned.nextCursor }
          : {}),
        activeNeeds: mine.cases.map((supportCase) => toNeed(supportCase, false)),
        ...(mine.nextCursor !== undefined ? { activeNextCursor: mine.nextCursor } : {}),
        alerts: [],
        quickShareCategories: CATEGORY_CARDS.filter((card) => card.disposition === 'OPERATIONAL'),
        // §9: no released definition for these, so no value is displayed.
        metrics: [
          { label: 'Responses', state: 'NOT_COMPUTABLE', reason: 'No released definition' },
          { label: 'Avg Response', state: 'NOT_COMPUTABLE', reason: 'No released definition' },
        ],
      }),
    );
  });

  app.get('/app/responder/availability', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    assertResponder(context);
    // G-I-30: on-duty is not a recorded fact. GET is display-only; POST stays 404.
    await reply.type(HTML).send(
      renderResponderAvailability({
        shell: shell('On Duty', { viewport: 'DESKTOP' }),
        duty: { status: 'UNAVAILABLE', reason: DUTY_UNAVAILABLE_REASON },
      }),
    );
  });

  const logContactBody = z.object({
    channel: z.enum(CONTACT_CHANNELS),
    outcome: z.enum(CONTACT_OUTCOMES),
  });

  const createServiceRequestBody = z.object({
    category: z.enum(SERVICE_CATEGORIES),
  });

  app.get<{ Params: { id: string } }>('/app/responder/cases/:id', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    assertResponder(context);
    const caseId = pathParams(request, 'case-id').id;
    if (caseId === undefined) throw new ResourceNotVisibleError();
    const supportCase = await findCase(pool, context.tenantId, caseId);
    if (supportCase === undefined) {
      throw new ResourceNotVisibleError();
    }
    const claimable = supportCase.status === 'OPEN' || supportCase.status === 'TRIAGED';
    const assignment = await findActiveAssignment(pool, supportCase.caseId);
    const canLogContact = assignment?.responderUserId === context.userId;
    const canCreateServiceRequest = supportCase.status !== 'CLOSED';
    // Sequential reads: Worker Hyperdrive Client-per-query is safer than
    // parallel pool.query under nodejs_compat.
    const attempts = await listContactAttempts(pool, context.tenantId, supportCase.caseId, 50);
    const serviceRequests = await listCaseServiceRequests(
      pool,
      context.tenantId,
      supportCase.caseId,
      50,
    );
    await reply.type(HTML).send(
      renderResponderCase({
        shell: shell('Case', { viewport: 'DESKTOP' }),
        need: toNeed(supportCase, claimable),
        contactAttempts: attempts.map((attempt) => ({
          channel: attempt.channel,
          outcome: attempt.outcome,
          attemptedAtLabel: new Date(attempt.attemptedAt).toISOString(),
        })),
        serviceRequests: serviceRequests.map((request) => ({
          category: request.category,
          status: request.status,
        })),
        ...(canLogContact ? { canLogContact: true } : {}),
        ...(canCreateServiceRequest ? { canCreateServiceRequest: true } : {}),
      }),
    );
  });

  app.post<{ Params: { id: string } }>(
    '/app/responder/cases/:id/service-requests',
    async (request, reply) => {
      const context = await authenticate(pool, sessionSecret, request);
      assertResponder(context);
      const caseId = pathParams(request, 'case-id').id;
      if (caseId === undefined) throw new ResourceNotVisibleError();
      const supportCase = await findCase(pool, context.tenantId, caseId);
      if (supportCase === undefined) {
        throw new ResourceNotVisibleError();
      }
      const body = createServiceRequestBody.parse(request.body ?? {});
      try {
        await withTransaction(pool, (tx) =>
          createServiceRequest(tx, {
            tenantId: context.tenantId,
            caseId,
            category: body.category,
            createdBy: context.userId,
            actorType: 'RESPONDER',
            correlationId: String(request.id),
          }),
        );
      } catch (error) {
        if (error instanceof CaseNotFoundError || error instanceof ClosedCaseError) {
          throw new ResourceNotVisibleError();
        }
        throw error;
      }
      return reply.redirect(`/app/responder/cases/${caseId}`, 303);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/app/responder/cases/:id/commands/log-contact-attempt',
    async (request, reply) => {
      const context = await authenticate(pool, sessionSecret, request);
      assertResponder(context);
      const caseId = pathParams(request, 'case-id').id;
      if (caseId === undefined) throw new ResourceNotVisibleError();
      const supportCase = await findCase(pool, context.tenantId, caseId);
      if (supportCase === undefined) {
        throw new ResourceNotVisibleError();
      }
      const body = logContactBody.parse(request.body ?? {});
      try {
        await recordContact(pool, {
          tenantId: context.tenantId,
          caseId,
          responderUserId: context.userId,
          command: 'log-contact-attempt',
          channel: body.channel,
          outcome: body.outcome,
          correlationId: String(request.id),
        });
      } catch (error) {
        if (error instanceof NoActiveAssignmentError) {
          throw new ResourceNotVisibleError();
        }
        throw error;
      }
      return reply.redirect(`/app/responder/cases/${caseId}`, 303);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/app/responder/cases/:id/commands/claim',
    async (request, reply) => {
      const context = await authenticate(pool, sessionSecret, request);
      assertResponder(context);
      const caseId = pathParams(request, 'case-id').id;
      if (caseId === undefined) throw new ResourceNotVisibleError();
      const existing = await findCase(pool, context.tenantId, caseId);
      if (existing === undefined) {
        throw new ResourceNotVisibleError();
      }
      // CLAIM_CASE is documented from OPEN/TRIAGED only. A same-responder
      // replay arrives when the case is already ASSIGNED, so treat "already
      // mine" as success rather than an illegal edge.
      const held = await findActiveAssignment(pool, caseId);
      if (held !== undefined) {
        if (held.responderUserId === context.userId) {
          return reply.redirect('/app/responder', 303);
        }
        throw new CaseAlreadyClaimedError();
      }
      try {
        await claimCase(pool, {
          tenantId: context.tenantId,
          caseId,
          responderUserId: context.userId,
          correlationId: String(request.id),
        });
      } catch (error) {
        if (
          !(error instanceof CaseAlreadyClaimedError) &&
          !(error instanceof IllegalCaseTransitionError)
        ) {
          throw error;
        }
        const assignment = await findActiveAssignment(pool, caseId);
        if (assignment?.responderUserId !== context.userId) throw error;
      }
      return reply.redirect('/app/responder', 303);
    },
  );

  app.get('/app/responder/needs', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    const query = activeNeedsQuery.parse(request.query ?? {});
    const queue = await readCaseQueue(
      pool,
      context.tenantId,
      { ownership: 'mine', responderUserId: context.userId },
      {
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      },
    );

    await reply.type(HTML).send(
      renderActiveNeeds({
        shell: shell('Active Needs', { viewport: 'DESKTOP' }),
        needs: queue.cases.map((supportCase) => toNeed(supportCase, false)),
        ...(queue.nextCursor !== undefined ? { nextCursor: queue.nextCursor } : {}),
      }),
    );
  });

  // --- Admin surface ---------------------------------------------------------

  app.get('/app/admin', async (request, reply) => {
    const context = await authenticate(pool, sessionSecret, request);
    // §7.5 asks for clearer scope than the prototype; ADMIN.md §2 and
    // SECURITY.md §2 supply the actual gate.
    assertSuasAdmin(context);
    assertMfaElevated(context, 'Viewing the admin overview');

    await reply.type(HTML).send(
      renderAdminOverview({
        shell: shell('SUAS Admin', { viewport: 'DESKTOP', showMobileNav: false }),
        tenantLabel: context.tenantId,
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
