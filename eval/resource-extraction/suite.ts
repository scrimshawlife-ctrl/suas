/**
 * Resource extraction eval (V1_PROJECT_PLAN.md F11; catalog builder F8).
 *
 * Runs the production extraction function against synthetic sources and scores what
 * comes back. Metrics, each 0..1 per case (null = not applicable to the case):
 *
 * - valid_output: the model answered with a well-formed tool call.
 * - resource_recall: expected resources found, matched by service name.
 * - resource_precision: returned resources that were expected (catches invented ones).
 * - category_accuracy / county_accuracy: over the matched resources.
 * - empty_when_none: a source with nothing usable produced zero resources.
 * - grounded_fields: every hours / contact value returned appears in the source text.
 *
 * Scores check extraction only. Whether a draft becomes a Resource is an administrator's
 * decision, never scored here.
 */

import { extractResourceDrafts, RESOURCE_EXTRACTION_TOOL } from '../../src/catalog/index.js';
import { defineSuite, type CaseScore } from '../harness.js';
import {
  RESOURCE_EXTRACTION_CASES,
  type ExpectedResource,
  type ResourceExtractionCase,
} from './cases.js';

const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

const ratio = (hit: number, total: number): number | null => (total === 0 ? null : hit / total);

function toToolInput(expected: readonly ExpectedResource[]) {
  return {
    resources: expected.map((resource) => ({
      service_name: resource.serviceName,
      category: resource.category,
      counties: [...resource.counties],
      ...(resource.hours !== undefined ? { hours: resource.hours } : {}),
      ...(resource.contactMethod !== undefined ? { contact_method: resource.contactMethod } : {}),
      ...(resource.contactMethodKind !== undefined
        ? { contact_method_kind: resource.contactMethodKind }
        : {}),
    })),
  };
}

export const resourceExtractionSuite = defineSuite<ResourceExtractionCase>({
  name: 'resource-extraction',
  description: 'Resource Drafts extracted from pasted synthetic sources.',
  cases: RESOURCE_EXTRACTION_CASES,

  // Baseline for the scripted fake: answers with the expected resources, so the run
  // proves the harness and scoring work. It says nothing about a real model.
  scriptedTurns: (testCase) => [
    {
      ok: true,
      text: '',
      toolCalls: [
        { id: 'eval-1', name: RESOURCE_EXTRACTION_TOOL, input: toToolInput(testCase.expected) },
      ],
    },
  ],

  async runCase(testCase, { inference }): Promise<CaseScore> {
    const result = await extractResourceDrafts(inference, {
      sourceText: testCase.sourceText,
      sourceLink: testCase.sourceLink,
    });
    if (!result.ok) {
      return {
        id: testCase.id,
        metrics: {
          valid_output: 0,
          resource_recall: testCase.expected.length === 0 ? null : 0,
          resource_precision: null,
          category_accuracy: null,
          county_accuracy: null,
          empty_when_none: testCase.expected.length === 0 ? 0 : null,
          grounded_fields: null,
        },
      };
    }

    const returned = result.resources;
    const byName = new Map(returned.map((r) => [normalize(r.service_name), r]));
    const matched = testCase.expected.flatMap((expected) => {
      const found = byName.get(normalize(expected.serviceName));
      return found === undefined ? [] : [{ expected, found }];
    });

    const source = normalize(testCase.sourceText);
    const groundedValues = returned.flatMap((r) =>
      [r.hours, r.contact_method].filter((v): v is string => typeof v === 'string'),
    );

    return {
      id: testCase.id,
      metrics: {
        valid_output: 1,
        resource_recall: ratio(matched.length, testCase.expected.length),
        resource_precision: ratio(matched.length, returned.length),
        category_accuracy: ratio(
          matched.filter((m) => m.found.category === m.expected.category).length,
          matched.length,
        ),
        county_accuracy: ratio(
          matched.filter((m) => sameSet(m.found.counties, m.expected.counties)).length,
          matched.length,
        ),
        empty_when_none: testCase.expected.length === 0 ? (returned.length === 0 ? 1 : 0) : null,
        grounded_fields: ratio(
          groundedValues.filter((v) => source.includes(normalize(v))).length,
          groundedValues.length,
        ),
      },
    };
  },
});
