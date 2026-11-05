/**
 * `search_resources` over the database: published (active) Resources only.
 *
 * The model never sees contact details or eligibility judgements; it sees the
 * fields in `assistant.ts`. The client gets the Veteran-facing projection of the
 * same rows, so a Resource shown to the Veteran always came from this table and
 * never from model text.
 */

import type { Queryable } from '../db/index.js';
import { searchResources, RESOURCE_MAX_PAGE_SIZE } from '../fulfillment/index.js';
import type { IntakeHost, IntakeResource } from './assistant.js';

export function createDatabaseIntakeHost(db: Queryable, tenantId: string): IntakeHost {
  return {
    async searchResources(input): Promise<readonly IntakeResource[]> {
      const page = await searchResources(
        db,
        tenantId,
        { activeOnly: true, ...(input.category !== undefined ? { category: input.category } : {}) },
        { limit: RESOURCE_MAX_PAGE_SIZE },
      );
      const words = (input.keywords ?? '')
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== '');
      return page.results
        .filter(({ resource }) => {
          if (words.length === 0) return true;
          const haystack = `${resource.serviceName} ${resource.eligibility ?? ''}`.toLowerCase();
          return words.some((word) => haystack.includes(word));
        })
        .map(({ resource, freshness, staleWarning }) => ({
          resourceId: resource.resourceId,
          serviceName: resource.serviceName,
          category: resource.category,
          counties: resource.counties,
          hours: resource.hours ?? null,
          cost: resource.cost ?? null,
          contactMethod: resource.contactMethod ?? null,
          contactMethodKind: resource.contactMethodKind ?? null,
          freshness,
          staleWarning,
        }));
    },
  };
}
