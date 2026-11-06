import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CheckInPage from './CheckInPage';
import { INCOMPLETE_TEXT, NOT_A_DIAGNOSIS } from './check-in-result';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const checkIn = {
  check_in_id: 'c1',
  questionnaire_version: 'qv-001',
  status: 'STARTED',
  completed_at: null,
  questions: [
    {
      question_id: 'q1',
      question_key: 'one',
      prompt: 'First question?',
      dimension: null,
      required: true,
      options: [
        { answer_option_id: 'o1a', option_key: 'A', label: 'Option one A' },
        { answer_option_id: 'o1b', option_key: 'B', label: 'Option one B' },
      ],
    },
    {
      question_id: 'q2',
      question_key: 'two',
      prompt: 'Second question?',
      dimension: null,
      required: false,
      options: [{ answer_option_id: 'o2a', option_key: 'A', label: 'Option two A' }],
    },
  ],
};

function completed(over: Record<string, unknown> = {}) {
  return {
    check_in_id: 'c1',
    questionnaire_version: 'qv-001',
    status: 'COMPLETED',
    completed_at: '2026-11-05T00:00:00Z',
    incomplete: false,
    already_completed: false,
    support_signal: null,
    support_case: null,
    ...over,
  };
}

function route(complete: unknown) {
  client.POST.mockImplementation((path: string) => {
    if (path === '/api/v0/check-ins') return Promise.resolve({ data: checkIn });
    if (path === '/api/v0/check-ins/{id}/responses') return Promise.resolve({ data: {} });
    if (path === '/api/v0/check-ins/{id}/commands/complete')
      return Promise.resolve({ data: complete });
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

function renderPage() {
  const user = userEvent.setup();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <MemoryRouter>
        <CheckInPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return user;
}

async function answerBoth(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByLabelText('Option one B'));
  await user.click(screen.getByRole('button', { name: 'Save answer' }));
  await user.click(await screen.findByLabelText('Option two A'));
  await user.click(screen.getByRole('button', { name: 'Save answer' }));
}

beforeEach(() => {
  client.POST.mockReset();
  window.scrollTo = vi.fn();
});

describe('CheckInPage', () => {
  it('starts, saves each answer, completes, and shows the neutral result', async () => {
    route(completed({ support_signal: { support_signal_id: 's1', level: 'YELLOW' } }));
    const user = renderPage();

    expect(await screen.findByText('Question 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Leave Check-In' })).toHaveAttribute('href', '/home');
    expect(
      screen.getByText('If you leave, you will start a new Check-In next time.'),
    ).toBeVisible();
    expect(screen.getByText(NOT_A_DIAGNOSIS)).toBeVisible();

    await user.click(screen.getByLabelText('Option one B'));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(await screen.findByText('Question 2 of 2')).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith('/api/v0/check-ins/{id}/responses', {
      params: { path: { id: 'c1' } },
      body: { question_id: 'q1', answer_option_id: 'o1b' },
    });
    // Focus lands on the labelled question heading, not on a bare container.
    expect(screen.getByRole('heading', { name: 'Second question?' })).toHaveFocus();

    await user.click(screen.getByLabelText('Option two A'));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));

    const heading = await screen.findByRole('heading', { name: 'Thank you for checking in.' });
    expect(heading).toHaveFocus();
    expect(screen.getByText('Your answers are saved.')).toBeVisible();
    expect(screen.queryByText('Need help right now?')).toBeNull();
    expect(client.POST).toHaveBeenCalledWith('/api/v0/check-ins/{id}/commands/complete', {
      params: { path: { id: 'c1' } },
    });
  });

  it('goes back with Previous question and keeps the earlier answer selected', async () => {
    route(completed());
    const user = renderPage();
    await user.click(await screen.findByLabelText('Option one B'));
    await user.click(screen.getByRole('button', { name: 'Save answer' }));
    await user.click(await screen.findByRole('button', { name: 'Previous question' }));
    expect(await screen.findByText('Question 1 of 2')).toBeInTheDocument();
    expect(screen.getByLabelText('Option one B')).toBeChecked();
  });

  it('adds the crisis panel for RED and says nothing about alerts or the answers', async () => {
    route(completed({ support_signal: { support_signal_id: 's1', level: 'RED' } }));
    const user = renderPage();
    await answerBoth(user);

    expect(await screen.findByText('Thank you for checking in.')).toBeInTheDocument();
    expect(screen.getByText('Need help right now?')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
    expect(screen.getByRole('link', { name: 'Call or text 988' })).toHaveAttribute(
      'href',
      'tel:988',
    );
    expect(screen.queryByText(/trusted contact|alert/i)).toBeNull();
    expect(screen.queryByText(/suggest|need support/i)).toBeNull();
  });

  it('offers a fresh Check-In when the server ended this one as incomplete', async () => {
    route(completed({ status: 'INCOMPLETE', incomplete: true }));
    const user = renderPage();
    await answerBoth(user);

    expect(await screen.findByText(INCOMPLETE_TEXT)).toBeInTheDocument();
    expect(client.POST.mock.calls.filter(([p]) => p === '/api/v0/check-ins')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() =>
      expect(client.POST.mock.calls.filter(([p]) => p === '/api/v0/check-ins')).toHaveLength(2),
    );
    expect(await screen.findByText('Question 1 of 2')).toBeInTheDocument();
    expect(screen.queryByText(INCOMPLETE_TEXT)).toBeNull();
  });
});
