/**
 * The Intake Assistant's two model tools and their input validation
 * (V1_PROJECT_PLAN.md §2.1: "Exactly two model tools").
 *
 * The tool list handed to the model and the names the executor accepts both come
 * from `INTAKE_TOOL_NAMES`, so a third tool cannot be added in one place only.
 */

import { z } from 'zod';
import { DESTINATION_MAX, MEETING_PLACE_MAX, type ServiceCategory } from '../coordination/index.js';
import type { ModelToolDefinition } from '../inference/index.js';

/** Categories the Intake Assistant may draft. Anything else is "not available yet". */
export const INTAKE_CATEGORIES = [
  'FOOD',
  'TRANSPORTATION',
  'SHELTER',
  'PEER_SUPPORT',
] as const satisfies readonly ServiceCategory[];
export type IntakeCategory = (typeof INTAKE_CATEGORIES)[number];

export const INTAKE_TOOL_NAMES = ['search_resources', 'draft_service_request'] as const;
export type IntakeToolName = (typeof INTAKE_TOOL_NAMES)[number];

export const SUMMARY_MAX = 280;
export const TIMING_MAX = 120;
export const KEYWORDS_MAX = 100;

export const searchResourcesInput = z
  .object({
    category: z.enum(INTAKE_CATEGORIES).optional(),
    keywords: z.string().trim().min(1).max(KEYWORDS_MAX).optional(),
    // True when the Veteran's need is not one of the four categories. The server then
    // shows its own "not available yet" notice instead of relying on model wording.
    outside_categories: z.boolean().optional(),
  })
  .strict();
export type SearchResourcesInput = z.infer<typeof searchResourcesInput>;

/** The fields the Veteran may edit on a draft. Shared with the edit route. */
export const draftDetailsInput = z
  .object({
    summary: z.string().trim().min(1).max(SUMMARY_MAX),
    timing: z.string().trim().min(1).max(TIMING_MAX).optional(),
    meeting_place: z.string().trim().min(1).max(MEETING_PLACE_MAX).optional(),
    destination: z.string().trim().min(1).max(DESTINATION_MAX).optional(),
  })
  .strict();
export type DraftDetails = z.infer<typeof draftDetailsInput>;

export const draftServiceRequestInput = draftDetailsInput
  .extend({ category: z.enum(INTAKE_CATEGORIES) })
  .strict();
export type DraftServiceRequestInput = z.infer<typeof draftServiceRequestInput>;

export function isIntakeCategory(value: unknown): value is IntakeCategory {
  return typeof value === 'string' && (INTAKE_CATEGORIES as readonly string[]).includes(value);
}

export const INTAKE_TOOLS: readonly ModelToolDefinition[] = [
  {
    name: 'search_resources',
    description:
      'Read-only search of published Resources. Optionally filter by category and by words that ' +
      'appear in the service name or eligibility text. Returns at most five Resources.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...INTAKE_CATEGORIES] },
        keywords: { type: 'string', maxLength: KEYWORDS_MAX },
        outside_categories: {
          type: 'boolean',
          description:
            'Set true when the Veteran needs something that is not one of the four categories.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'draft_service_request',
    description:
      "Create or replace the Veteran's draft request. The Veteran reviews and submits it; " +
      'this does not submit anything.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...INTAKE_CATEGORIES] },
        summary: { type: 'string', maxLength: SUMMARY_MAX },
        timing: { type: 'string', maxLength: TIMING_MAX },
        meeting_place: {
          type: 'string',
          maxLength: MEETING_PLACE_MAX,
          description:
            'Where to meet, such as a public place or a pickup spot, if the Veteran said. ' +
            'Needed for FOOD, TRANSPORTATION and SHELTER. Do not guess one.',
        },
        destination: {
          type: 'string',
          maxLength: DESTINATION_MAX,
          description:
            'Where a ride is going, for TRANSPORTATION only, if the Veteran said. Do not guess one.',
        },
      },
      required: ['category', 'summary'],
      additionalProperties: false,
    },
  },
];
