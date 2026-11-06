/**
 * Creating a Service Request on behalf of a Veteran: the plain request form and
 * the submit step of a Service Request Draft share this one path.
 *
 * V1_PROJECT_PLAN.md F3 / §4.3: reuses `openCase`, `createServiceRequest` and the
 * `SUBMIT` command (generalising `deployQrfInTx`, which only knew PEER_SUPPORT).
 * The `SUBMIT` command is what puts the request on the helper list (DISPATCH.md §4).
 * AGENTS.md rule 14: this runs only because the Veteran asked for it; the model
 * has no route to it.
 */

import type { PoolClient } from 'pg';
import {
  createServiceRequest,
  executeServiceRequestCommandInTx,
  openCase,
  type ServiceRequest,
} from '../coordination/index.js';
import type { JsonObject } from '../jobs/index.js';
import {
  DraftIncompleteError,
  DraftNotEditableError,
  findOwnedDraft,
  markDraftSubmitted,
  draftDetails,
  type ServiceRequestDraft,
} from './drafts.js';
import { isIntakeCategory, type IntakeCategory } from './tools.js';

export interface VeteranRequestInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly category: IntakeCategory;
  readonly details: JsonObject;
  readonly correlationId: string;
}

/** Open (or reuse) the Veteran's Support Case, create the request, and submit it. */
export async function createSubmittedRequestInTx(
  tx: PoolClient,
  input: VeteranRequestInput,
): Promise<ServiceRequest> {
  const opened = await openCase(tx, {
    tenantId: input.tenantId,
    veteranUserId: input.veteranUserId,
    actorType: 'VETERAN',
    actorId: input.veteranUserId,
    correlationId: input.correlationId,
  });
  const created = await createServiceRequest(tx, {
    tenantId: input.tenantId,
    caseId: opened.supportCase.caseId,
    category: input.category,
    createdBy: input.veteranUserId,
    actorType: 'VETERAN',
    details: input.details,
    correlationId: input.correlationId,
  });
  return executeServiceRequestCommandInTx(tx, {
    tenantId: input.tenantId,
    serviceRequestId: created.serviceRequestId,
    command: 'SUBMIT',
    actorId: input.veteranUserId,
    actorType: 'VETERAN',
    correlationId: input.correlationId,
  });
}

export interface SubmitDraftResult {
  readonly draft: ServiceRequestDraft;
  readonly serviceRequest: ServiceRequest;
}

/**
 * Submit the Veteran's draft. Locks the draft row so two submits cannot each
 * create a request. The intake text stays on the draft; only the category and the
 * reviewed fields move to the Service Request.
 */
export async function submitDraftInTx(
  tx: PoolClient,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly draftId: string;
    readonly correlationId: string;
  },
): Promise<SubmitDraftResult> {
  const draft = await findOwnedDraft(tx, input.tenantId, input.userId, input.draftId, {
    lock: true,
  });
  if (draft.status !== 'DRAFT') throw new DraftNotEditableError();
  const { category, summary } = draft.fields;
  if (!isIntakeCategory(category) || summary === null) throw new DraftIncompleteError();

  const serviceRequest = await createSubmittedRequestInTx(tx, {
    tenantId: input.tenantId,
    veteranUserId: input.userId,
    category,
    details: draftDetails(draft.fields),
    correlationId: input.correlationId,
  });
  const submitted = await markDraftSubmitted(tx, draft, serviceRequest.serviceRequestId);
  return { draft: submitted, serviceRequest };
}
