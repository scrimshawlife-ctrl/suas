import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import VerifyPage from '../request/VerifyPage';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const CONFIRM = '/api/v0/veterans/me/verification/va/confirm';

function renderVerify(from?: string) {
  tokenStore.setToken('tok');
  const router = createMemoryRouter([{ path: '/verify', element: <VerifyPage /> }], {
    initialEntries: [{ pathname: '/verify', state: from === undefined ? null : { from } }],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { queryClient, router };
}

// The standing is read from GET /veterans/me (suas-specs #72 R9.1, proposal).
const me = (status: string, reason: string | null = null) => ({
  data: {
    id_verification: {
      method: 'VA_VETERAN_STATUS',
      status,
      not_confirmed_reason: reason,
      verified_at: null,
    },
  },
});
const answer = (status: string, reason: string | null = null) => ({
  data: {
    status,
    not_confirmed_reason: reason,
    verified_at: status === 'VERIFIED' ? '2026-11-10T00:00:00Z' : null,
  },
});

const PERSON = {
  'First name': 'Synthetic',
  'Last name': 'Veteran',
  Month: '1',
  Day: '2',
  Year: '1970',
  'Street address': '1 Example Way',
  City: 'Exampleton',
  'ZIP code': '00002',
};

async function fillForm(user: UserEvent, changes: Partial<typeof PERSON> = {}) {
  for (const [label, value] of Object.entries({ ...PERSON, ...changes })) {
    await user.clear(screen.getByLabelText(label));
    await user.type(screen.getByLabelText(label), value);
  }
  await user.selectOptions(screen.getByLabelText('State'), 'CA');
}

const send = (user: UserEvent) => user.click(screen.getByRole('button', { name: 'Send to VA' }));
const sentKey = (call: number) =>
  (client.POST.mock.calls[call]?.[1] as { params: { header: Record<string, string> } }).params
    .header['Idempotency-Key'];

beforeEach(() => {
  tokenStore.clear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  client.GET.mockReset();
  client.POST.mockReset();
  client.GET.mockResolvedValue(me('NOT_STARTED'));
});

describe('Verify page start', () => {
  it('names the crisis links and includes text 988', async () => {
    renderVerify();
    const call911 = await screen.findByRole('link', { name: 'Call 911' });
    expect(call911).toHaveAttribute('href', 'tel:911');
    expect(screen.getByRole('link', { name: 'Call 988' })).toHaveAttribute('href', 'tel:988');
    expect(screen.getByRole('link', { name: 'Text 988' })).toHaveAttribute('href', 'sms:988');
    expect(screen.getByRole('region', { name: /Immediate danger\? Call 911/ })).toHaveTextContent(
      /For suicide or emotional crisis support,\s*call\s*or\s*text 988/,
    );
    // SAFETY_COPY.md §2.1 compact banner, Veterans Crisis Line line (D-050).
    expect(screen.getByRole('region', { name: /Immediate danger\? Call 911/ })).toHaveTextContent(
      /Veterans Crisis Line:\s*Text 838255\./,
    );
    const text838255 = screen.getByRole('link', { name: 'Veterans Crisis Line: Text 838255' });
    expect(text838255).toHaveAttribute('href', 'sms:838255');
    expect(text838255).toHaveClass('inline-flex', 'min-h-11', 'min-w-11');
  });

  it('gives the notice before the form, and no ID scan or selfie', async () => {
    renderVerify();
    const notice = await screen.findByText(/We send VA your name, date of birth and home address/);
    const form = screen.getByRole('form', { name: 'Your details for VA' });
    expect(notice.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/SUAS keeps the result, not these details/)).toBeInTheDocument();
    expect(
      screen.getByText("If VA can't confirm your status, it doesn't mean you didn't serve."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/selfie|ID scan|card photo|camera|upload/i)).toBeNull();
    expect(screen.getByLabelText('First name')).toHaveAttribute('autocomplete', 'given-name');
    expect(screen.getByLabelText('Year')).toHaveAttribute('autocomplete', 'bday-year');
    expect(screen.getByLabelText('State')).toHaveAttribute('autocomplete', 'address-level1');
    expect(screen.getByLabelText('ZIP code')).toHaveAttribute('autocomplete', 'postal-code');
  });
});

describe('Verify form validation', () => {
  it('lists every missing field, links each error and focuses the first', async () => {
    const user = userEvent.setup();
    renderVerify();
    await screen.findByLabelText('First name');
    await send(user);
    const summary = await screen.findByRole('region', { name: 'Check these details' });
    expect(within(summary).getAllByRole('link')).toHaveLength(7);
    const first = screen.getByLabelText('First name');
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveAccessibleDescription('Enter your first name.');
    expect(screen.getByLabelText('Month')).toHaveAccessibleDescription(
      /For example: 4 28 1986\s+Enter your date of birth\./,
    );
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('shows pattern and future birth date errors before sending', async () => {
    const user = userEvent.setup();
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user, { 'First name': 'José', Year: '2999' });
    await send(user);
    expect(screen.getByLabelText('First name')).toHaveAccessibleDescription(/letters only/);
    expect(screen.getByLabelText('Month')).toHaveAccessibleDescription(
      /Your date of birth must be in the past\./,
    );
    expect(client.POST).not.toHaveBeenCalled();
  });
});

describe('Verify sending', () => {
  it('sends the exact body with an Idempotency-Key, once for a double click', async () => {
    const user = userEvent.setup();
    let settle: (value: unknown) => void = () => undefined;
    client.POST.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user);
    await user.dblClick(screen.getByRole('button', { name: 'Send to VA' }));
    expect(client.POST).toHaveBeenCalledTimes(1);
    expect(client.POST).toHaveBeenCalledWith(CONFIRM, {
      body: {
        firstName: 'Synthetic',
        lastName: 'Veteran',
        birthDate: '1970-01-02',
        streetAddressLine1: '1 Example Way',
        city: 'Exampleton',
        state: 'CA',
        zipCode: '00002',
        country: 'USA',
      },
      params: { header: { 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) as string } },
    });
    settle(answer('NOT_CONFIRMED', 'PERSON_NOT_FOUND'));
    await screen.findByRole('heading', { name: "VA couldn't match your details" });
  });

  it('reuses the key for the same details and takes a new one after an edit', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValue(answer('NOT_CONFIRMED', 'PERSON_NOT_FOUND'));
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user);
    await send(user);
    await screen.findByRole('heading', { name: "VA couldn't match your details" });
    await send(user);
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(sentKey(1)).toBe(sentKey(0));

    await user.clear(screen.getByLabelText('ZIP code'));
    await user.type(screen.getByLabelText('ZIP code'), '00001');
    await send(user);
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(3));
    expect(sentKey(2)).not.toBe(sentKey(0));
  });

  it('keeps the details out of storage, the address and the query cache', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValue(answer('VERIFIED'));
    const { queryClient, router } = renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user);
    await send(user);
    await screen.findByRole('heading', { name: /You're confirmed/ });
    const kept = [
      JSON.stringify({ ...window.localStorage }),
      JSON.stringify({ ...window.sessionStorage }),
      JSON.stringify(router.state.location),
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ].join(' ');
    for (const value of ['Synthetic', 'Exampleton', '1970-01-02', '00002']) {
      expect(kept).not.toContain(value);
    }
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
  });
});

describe('Verify results', () => {
  it('VERIFIED: focuses the confirmed heading and continues to where the person was going', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValue(answer('VERIFIED'));
    renderVerify('/request?category=FOOD');
    await screen.findByLabelText('First name');
    await fillForm(user, { 'ZIP code': '00001' });
    await send(user);
    const heading = await screen.findByRole('heading', { name: /You're confirmed/ });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      '/request?category=FOOD',
    );
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('VERIFIED without a return path continues to /request', async () => {
    client.GET.mockResolvedValue(me('VERIFIED'));
    renderVerify();
    expect(await screen.findByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      '/request',
    );
  });

  it('PERSON_NOT_FOUND: gives tips and keeps the form filled', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValue(answer('NOT_CONFIRMED', 'PERSON_NOT_FOUND'));
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user);
    await send(user);
    const heading = await screen.findByRole('heading', { name: "VA couldn't match your details" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.getByText(/try it without the apostrophe: OLeary/)).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Synthetic');
    expect(screen.getByLabelText('ZIP code')).toHaveValue('00002');
    expect(screen.queryByText(/PERSON_NOT_FOUND/)).toBeNull();
  });

  it.each(['NOT_TITLE_38', 'MORE_RESEARCH_REQUIRED'])(
    '%s: says it is not a finding, offers Serve, crisis and different details',
    async (reason) => {
      const user = userEvent.setup();
      client.POST.mockResolvedValue(answer('NOT_CONFIRMED', reason));
      renderVerify();
      await screen.findByLabelText('First name');
      await fillForm(user, { 'ZIP code': '00003' });
      await send(user);
      expect(
        await screen.findByRole('heading', { name: 'VA did not confirm your Veteran status' }),
      ).toBeInTheDocument();
      expect(screen.getByText(/This is not a finding that you never served\./)).toBeInTheDocument();
      expect(screen.getByText('You can ask VA to review your records.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
      expect(screen.getByRole('link', { name: 'More crisis options' })).toHaveAttribute(
        'href',
        '/crisis',
      );
      expect(document.body.textContent).not.toMatch(/NOT_TITLE_38|MORE_RESEARCH_REQUIRED/);
      expect(screen.queryByRole('form')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Try different details' }));
      expect(screen.getByRole('heading', { name: 'Confirm your Veteran status' })).toHaveFocus();
      expect(screen.getByLabelText('ZIP code')).toHaveValue('00003');
    },
  );

  it.each([
    ['a 200 UNAVAILABLE', () => client.POST.mockResolvedValue(answer('UNAVAILABLE', 'ERROR'))],
    [
      'a 503',
      () =>
        client.POST.mockRejectedValue(
          new ApiError(503, 'ID_VERIFICATION_UNAVAILABLE', 'not available'),
        ),
    ],
  ])('%s says VA cannot be reached and nothing was kept', async (_label, arrange) => {
    const user = userEvent.setup();
    arrange();
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user, { 'ZIP code': '00005' });
    await send(user);
    expect(
      await screen.findByRole('heading', { name: "VA can't be reached right now" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing you entered was kept\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('429: says the limit is reached and when to try again', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(
      new ApiError(429, 'VERIFICATION_ATTEMPT_LIMIT', 'limit', 3 * 3600),
    );
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user);
    await send(user);
    expect(
      await screen.findByRole('heading', { name: "You've reached today's limit of tries" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^Try again after \d{1,2}:\d{2}\s[AP]M (today|tomorrow)\.$/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('403 VERIFICATION_REVOKED: says it was withdrawn and offers Serve', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(new ApiError(403, 'VERIFICATION_REVOKED', 'revoked'));
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user);
    await send(user);
    expect(
      await screen.findByRole('heading', { name: 'Your confirmation was withdrawn' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
  });

  it('a REVOKED standing shows no form and no retry', async () => {
    client.GET.mockResolvedValue(me('REVOKED'));
    renderVerify();
    expect(
      await screen.findByRole('heading', { name: 'Your confirmation was withdrawn' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button', { name: /try/i })).toBeNull();
    expect(screen.getByRole('link', { name: 'More crisis options' })).toHaveAttribute(
      'href',
      '/crisis',
    );
  });

  it('a connection failure keeps the form and says so', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(new ApiError(500, 'INTERNAL', 'Server error'));
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user);
    await send(user);
    expect(
      await screen.findByText(
        'We could not send your details. Check your connection and try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Synthetic');
  });
});
