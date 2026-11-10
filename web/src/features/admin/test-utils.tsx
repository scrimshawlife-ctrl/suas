import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import type { ResourceDraft } from './draft-form';

/** Renders a page inside a router and query client, like the app does. */
export function renderAt(
  routes: RouteObject[],
  initialEntries: (string | { pathname: string; state?: unknown })[],
) {
  const router = createMemoryRouter(routes, { initialEntries });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, queryClient };
}

export const renderPage = (element: ReactElement, path = '/page') =>
  renderAt([{ path, element }], [path]);

export function makeDraft(overrides: Partial<ResourceDraft> = {}): ResourceDraft {
  return {
    resource_draft_id: '11111111-1111-4111-8111-111111111111',
    status: 'DRAFT',
    source_link: 'https://pantry.example.invalid/hours',
    service_name: 'Willow Creek Veterans Pantry',
    category: 'FOOD',
    counties: ['SANTA_CLARA'],
    eligibility: null,
    hours: 'Weekdays 9-5',
    contact_method: '408-555-0100',
    contact_method_kind: 'PHONE',
    contacts: [{ kind: 'PHONE', value: '408-555-0100' }],
    area: null,
    referral_method: null,
    cost: null,
    published_resource_id: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: '2026-11-04T10:00:00.000Z',
    updated_at: '2026-11-04T10:00:00.000Z',
    ...overrides,
  };
}
