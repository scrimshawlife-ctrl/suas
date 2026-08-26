/**
 * Veteran Check-In HTTP surface.
 *
 * Spec citations:
 * - SUAS-specs API.md §3 (`/check-ins`), §4 (session; server-derived tenant),
 *   §8 (start/response/complete)
 * - SUAS-specs CHECKINS.md §1 (input artifact), §4 (states), §5 (published
 *   version bound at start), §6 (completion requests durable compute)
 * - SUAS-specs EVENT_MODEL.md §3.1 (CHECKIN_COMPLETED is not a settled signal)
 *
 * Completing a qv-001 Check-In runs `support-signal.compute` through the app
 * job queue. RED opens a Support Case; non-RED does not.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { ResourceNotVisibleError } from '../../authz/index.js';
import { findNonClosedCase } from '../../coordination/index.js';
import type { DurableJobQueuePort } from '../../jobs/index.js';
import { API_PREFIX } from '../../release/pins.js';
import {
  completeCheckIn,
  effectiveSignal,
  findCheckIn,
  listQuestionsWithOptions,
  saveResponse,
  startCheckIn,
  type CheckIn,
  type QuestionWithOptions,
} from '../../signals/index.js';

export interface CheckInRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly jobQueue?: DurableJobQueuePort;
}

const idParams = z.object({ id: z.string().uuid() });

const responseBody = z.object({
  question_id: z.string().uuid(),
  answer_option_id: z.string().uuid(),
});

function publicCheckIn(checkIn: CheckIn) {
  return {
    check_in_id: checkIn.checkInId,
    questionnaire_version: checkIn.questionnaireVersion,
    status: checkIn.status,
    completed_at: checkIn.completedAt?.toISOString() ?? null,
  };
}

function publicQuestions(questions: readonly QuestionWithOptions[]) {
  return questions.map((question) => ({
    question_id: question.questionId,
    question_key: question.questionKey,
    prompt: question.prompt,
    dimension: question.dimension ?? null,
    required: question.required,
    options: question.options.map((option) => ({
      answer_option_id: option.answerOptionId,
      option_key: option.optionKey,
      label: option.label,
    })),
  }));
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

export function registerCheckInRoutes(app: FastifyInstance, deps: CheckInRouteDeps): void {
  app.post(`${API_PREFIX}/check-ins`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const checkIn = await startCheckIn(deps.pool, {
      tenantId: context.tenantId,
      veteranUserId: context.userId,
    });
    const questions = await listQuestionsWithOptions(deps.pool, checkIn.questionnaireVersion);
    return reply.status(201).send({
      ...publicCheckIn(checkIn),
      questions: publicQuestions(questions),
    });
  });

  app.get(`${API_PREFIX}/check-ins/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const checkIn = await loadOwnedCheckIn(deps.pool, context.tenantId, context.userId, id);
    const questions = await listQuestionsWithOptions(deps.pool, checkIn.questionnaireVersion);
    return { ...publicCheckIn(checkIn), questions: publicQuestions(questions) };
  });

  app.post(`${API_PREFIX}/check-ins/:id/responses`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    await loadOwnedCheckIn(deps.pool, context.tenantId, context.userId, id);
    const body = responseBody.parse(request.body);
    await saveResponse(deps.pool, {
      tenantId: context.tenantId,
      checkInId: id,
      questionId: body.question_id,
      answerOptionId: body.answer_option_id,
    });
    const checkIn = await findCheckIn(deps.pool, context.tenantId, id);
    if (checkIn === undefined) throw new ResourceNotVisibleError();
    return publicCheckIn(checkIn);
  });

  app.post(`${API_PREFIX}/check-ins/:id/commands/complete`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    await loadOwnedCheckIn(deps.pool, context.tenantId, context.userId, id);
    const outcome = await completeCheckIn(
      deps.pool,
      { tenantId: context.tenantId, checkInId: id, actorId: context.userId },
      deps.jobQueue !== undefined ? { jobQueue: deps.jobQueue } : {},
    );
    const signal = outcome.incomplete
      ? undefined
      : await effectiveSignal(deps.pool, context.tenantId, context.userId);
    const supportCase =
      signal?.level === 'RED'
        ? await findNonClosedCase(deps.pool, context.tenantId, context.userId)
        : undefined;
    return {
      ...publicCheckIn(outcome.checkIn),
      incomplete: outcome.incomplete,
      already_completed: outcome.alreadyCompleted,
      support_signal:
        signal === undefined
          ? null
          : {
              support_signal_id: signal.supportSignalId,
              level: signal.level,
            },
      support_case:
        supportCase === undefined
          ? null
          : {
              case_id: supportCase.caseId,
              status: supportCase.status,
              priority_signal_level: supportCase.prioritySignalLevel ?? null,
            },
    };
  });
}
