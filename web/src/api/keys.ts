/**
 * Query key factories. Conventions are in web/README.md ("Query keys").
 * A feature adds its own factory here with `resourceKeys('name')` and extends it.
 */
export interface ResourceKeys<Filters = unknown> {
  readonly all: readonly [string];
  lists(): readonly [string, 'list'];
  list(filters?: Filters): readonly [string, 'list', Filters | undefined];
  details(): readonly [string, 'detail'];
  detail(id: string): readonly [string, 'detail', string];
}

export function resourceKeys<Filters = unknown>(resource: string): ResourceKeys<Filters> {
  const all = [resource] as const;
  return {
    all,
    lists: () => [resource, 'list'] as const,
    list: (filters) => [resource, 'list', filters] as const,
    details: () => [resource, 'detail'] as const,
    detail: (id) => [resource, 'detail', id] as const,
  };
}

export const queryKeys = {
  /** The signed-in person: GET /veterans/me. */
  me: ['me'] as const,
  serviceRequests: resourceKeys('service-requests'),
  chatMessages: (serviceRequestId: string) => ['chat', serviceRequestId, 'messages'] as const,
  chatThreads: ['chat', 'threads'] as const,
  intake: resourceKeys('intake'),
  notifications: resourceKeys('notifications'),
  resources: resourceKeys('resources'),
  adminDrafts: resourceKeys('admin-resource-drafts'),
};
