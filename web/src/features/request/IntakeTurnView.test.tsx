import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { IntakeTurn } from './api';
import { FALLBACK_NOTICE, IntakeTurnView, turnNeedsForm } from './IntakeTurnView';

const draft = {
  draft_id: '11111111-1111-4111-8111-111111111111',
  status: 'DRAFT',
  category: 'FOOD',
  summary: 'Groceries',
  timing: null,
  meeting_place: null,
  service_request_id: null,
  created_at: '2026-11-04T00:00:00.000Z',
  updated_at: '2026-11-04T00:00:00.000Z',
  submitted_at: null,
} as const;

const resource = {
  resource_id: '22222222-2222-4222-8222-222222222222',
  service_name: 'Example Food Pantry',
  category: 'FOOD',
  counties: ['SANTA_CLARA'],
  hours: null,
  cost: null,
  contact_method: null,
  contact_method_kind: null,
  freshness: 'CURRENT',
  stale_warning: false,
};

function turn(overrides: Partial<IntakeTurn>): IntakeTurn {
  return {
    outcome: 'NO_DRAFT',
    assistant_message: null,
    not_available_yet: false,
    notice: null,
    draft: null,
    resources: [],
    request_form: null,
    ...overrides,
  };
}

function show(value: IntakeTurn) {
  render(
    <MemoryRouter>
      <IntakeTurnView turn={value} />
    </MemoryRouter>,
  );
}

describe('IntakeTurnView', () => {
  it('DRAFT_READY shows the reply and its listings as links to the category page', () => {
    show(
      turn({
        outcome: 'DRAFT_READY',
        assistant_message: 'I drafted a food request.',
        draft: { ...draft },
        resources: [resource],
      }),
    );
    expect(screen.getByText('I drafted a food request.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Example Food Pantry' })).toHaveAttribute(
      'href',
      '/resources/food',
    );
  });

  it('NO_DRAFT with not_available_yet shows the server notice', () => {
    show(
      turn({
        assistant_message: 'That is outside what SUAS can take.',
        not_available_yet: true,
        notice:
          'SUAS cannot take requests for that need yet. Resources that may help are listed below.',
      }),
    );
    expect(screen.getByText(/cannot take requests for that need yet/)).toBeInTheDocument();
    expect(screen.queryByText('Listings that may help')).not.toBeInTheDocument();
  });

  it('FALLBACK_FORM says the assistant is unavailable and asks for the form', () => {
    const fallback = turn({
      outcome: 'FALLBACK_FORM',
      request_form: { method: 'POST', path: '/api/v0/service-requests' },
    });
    expect(turnNeedsForm(fallback)).toBe(true);
    show(fallback);
    expect(screen.getByText(FALLBACK_NOTICE)).toBeInTheDocument();
  });

  it('warns on a stale listing', () => {
    show(turn({ resources: [{ ...resource, stale_warning: true }] }));
    expect(screen.getByText(/may be out of date/)).toBeInTheDocument();
    expect(turnNeedsForm(turn({}))).toBe(false);
  });
});
