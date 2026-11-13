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
const SELF_ATTEST = '/api/v0/veterans/me/verification/commands/self-attest';

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
const answer = (
  status: string,
  reason: string | null = null,
  failureClass: string | null = null,
) => ({
  data: {
    status,
    not_confirmed_reason: reason,
    verified_at: status === 'VERIFIED' ? '2026-11-10T00:00:00Z' : null,
    failure_class: failureClass,
  },
});
const attested = {
  data: {
    method: 'SELF_ATTESTATION',
    status: 'VERIFIED',
    not_confirmed_reason: null,
    verified_at: '2026-11-11T00:00:00Z',
    failure_class: null,
  },
};

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
const sendWith = async (user: UserEvent, changes: Partial<typeof PERSON> = {}) => {
  await screen.findByLabelText('First name');
  await fillForm(user, changes);
  await send(user);
};
const tellUs = (user: UserEvent) =>
  user.click(screen.getByRole('button', { name: 'Tell us you served' }));
/** Serve and the crisis screen stay one tap away on every view that is not a confirmation. */
function expectHelpOthers() {
  expect(screen.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
  expect(screen.getByRole('link', { name: 'More crisis options' })).toHaveAttribute(
    'href',
    '/crisis',
  );
}
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
    const call988 = screen.getByRole('link', { name: 'Call 988' });
    const text988 = screen.getByRole('link', { name: 'Text 988' });
    expect(call911).toHaveAttribute('href', 'tel:911');
    expect(call988).toHaveAttribute('href', 'tel:988');
    expect(text988).toHaveAttribute('href', 'sms:988');
    // 44px tap targets (WCAG 2.2) on every crisis link.
    for (const link of [call911, call988, text988]) {
      expect(link).toHaveClass('inline-flex', 'min-h-11', 'min-w-11');
    }
    expect(
      screen.getByRole('heading', { name: /Immediate danger\? Call 911/ }),
    ).toBeInTheDocument();
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

  it('gives the va-notice-v1 notice before the form, and no ID scan or selfie', async () => {
    renderVerify();
    const notice = await screen.findByRole('region', { name: 'Before you send anything to VA' });
    const form = screen.getByRole('form', { name: 'Your details for VA' });
    expect(notice.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // VETERAN_VERIFICATION §9: what goes where, no benefits decision, VA is optional, what is kept.
    expect(notice).toHaveTextContent(/current address or where you get mail/);
    expect(notice).toHaveTextContent(/leave SUAS and go to VA's Veteran Confirmation service/);
    expect(notice).toHaveTextContent(/Neither VA nor SUAS decides any benefits or eligibility/);
    expect(notice).toHaveTextContent(/not a finding that you didn't serve/);
    expect(notice).toHaveTextContent(/Checking with VA is your choice\./);
    expect(notice).toHaveTextContent(/a keyed fingerprint of your details/);
    expect(notice).toHaveTextContent(/Helping other Veterans needs no check\./);
    expect(document.body.textContent).not.toMatch(/nothing (you entered )?(was )?kept/i);
    expect(screen.queryByText(/selfie|ID scan|card photo|camera|upload/i)).toBeNull();
    expect(screen.getByText('Your current address or where you get mail.')).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveAttribute('autocomplete', 'given-name');
    expect(screen.getByLabelText('Year')).toHaveAttribute('autocomplete', 'bday-year');
    expect(screen.getByLabelText('State')).toHaveAttribute('autocomplete', 'address-level1');
    expect(screen.getByLabelText('ZIP code')).toHaveAttribute('autocomplete', 'postal-code');
  });

  it('offers "Tell us you served" beside "Send to VA", at the same size', async () => {
    renderVerify();
    const va = await screen.findByRole('button', { name: 'Send to VA' });
    const self = screen.getByRole('button', { name: 'Tell us you served' });
    expect(va.parentElement).toBe(self.parentElement);
    expect(self).toHaveClass('min-h-14');
    expect(va).toHaveClass('min-h-14');
  });

  it('a failed standing read says so and can be read again', async () => {
    const user = userEvent.setup();
    // A 4xx: the me query does not retry it, so the error card shows at once.
    client.GET.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'Slow down'));
    renderVerify();
    expect(await screen.findByText('We could not load your check status.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Confirm your Veteran status' }),
    ).toBeInTheDocument();
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
        noticeVersion: 'va-notice-v1',
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
    expect(
      screen.getByText('You can try different details, or tell us you served instead.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
    expectHelpOthers();
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
      expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
      expectHelpOthers();
      expect(document.body.textContent).not.toMatch(/NOT_TITLE_38|MORE_RESEARCH_REQUIRED/);
      expect(screen.queryByRole('form')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Try different details' }));
      expect(screen.getByRole('heading', { name: 'Confirm your Veteran status' })).toHaveFocus();
      expect(screen.getByLabelText('ZIP code')).toHaveValue('00003');
    },
  );

  it('a 200 UNAVAILABLE outage: not counted, try again, Serve, crisis and self-attest', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValue(answer('UNAVAILABLE', 'ERROR', 'PROVIDER_UNAVAILABLE'));
    renderVerify();
    await sendWith(user, { 'ZIP code': '00005' });
    expect(
      await screen.findByRole('heading', { name: "VA can't be reached right now" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/This didn't use one of your tries\./)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/nothing (you entered )?(was )?kept/i);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
    expectHelpOthers();
    expect(screen.queryByRole('form')).toBeNull();

    // Try again reopens the filled form; it does not send by itself.
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByLabelText('ZIP code')).toHaveValue('00005');
    expect(client.POST).toHaveBeenCalledTimes(1);
  });

  it('a VA 400 (REQUEST_INVALID) is correctable: the form stays filled, no outage words', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValue(answer('UNAVAILABLE', null, 'REQUEST_INVALID'));
    renderVerify();
    await sendWith(user);
    const heading = await screen.findByRole('heading', {
      name: "We couldn't send your details to VA",
    });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(
      screen.getByText("Check them and try again. This didn't use one of your tries."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/can't be reached/)).toBeNull();
    expect(screen.getByLabelText('First name')).toHaveValue('Synthetic');
    expect(screen.getByRole('button', { name: 'Send to VA' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
  });

  it('503 ID_VERIFICATION_UNAVAILABLE: the VA check is off here, not an outage', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(new ApiError(503, 'ID_VERIFICATION_UNAVAILABLE', 'off'));
    renderVerify();
    await sendWith(user);
    expect(
      await screen.findByRole('heading', { name: 'The VA check is off here' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/can't be reached/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
    expectHelpOthers();
  });

  it('429: the 5-try or 20-check limit in the last 24 hours (never "today"), crisis, Serve and self-attest', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(
      new ApiError(429, 'VERIFICATION_ATTEMPT_LIMIT', 'limit', 3 * 3600),
    );
    renderVerify();
    await sendWith(user);
    expect(
      await screen.findByRole('heading', { name: "You've reached the limit for VA checks" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /^You've reached the most VA checks allowed in the last 24 hours\. You can try VA again after \d{1,2}:\d{2}\s[AP]M( tomorrow)?\. You can still tell us you served instead\.$/,
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/today/i);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
    expectHelpOthers();
  });

  it('409 VA_NAME_MISMATCH: asks for the account name and keeps the form filled', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(new ApiError(409, 'VA_NAME_MISMATCH', 'name'));
    renderVerify();
    await sendWith(user);
    expect(
      await screen.findByRole('heading', { name: 'Use the name on your account' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/This didn't use one of your tries\./)).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Synthetic');
    expect(screen.getByRole('button', { name: 'Send to VA' })).toBeInTheDocument();
  });

  it('409 VA_IDENTITY_ALREADY_VERIFIED: a generic refusal that never hints at another account', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(new ApiError(409, 'VA_IDENTITY_ALREADY_VERIFIED', 'taken'));
    renderVerify();
    await sendWith(user);
    expect(
      await screen.findByRole('heading', { name: "We can't use these details" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "These details can't be used to verify this account. You can tell us you served instead.",
      ),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/another account|other account|sign in with/i);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
    expectHelpOthers();
  });

  it('409 IDEMPOTENCY_CONFLICT: says to send again, and the next send takes a new key', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValueOnce(new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'conflict'));
    client.POST.mockResolvedValueOnce(answer('NOT_CONFIRMED', 'PERSON_NOT_FOUND'));
    renderVerify();
    await sendWith(user);
    expect(
      await screen.findByText(
        "We couldn't send your details just now. Wait a moment, then send them again.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to VA' })).toBeEnabled();
    await send(user);
    await screen.findByRole('heading', { name: "VA couldn't match your details" });
    expect(sentKey(1)).not.toBe(sentKey(0));
  });

  it('403 VERIFICATION_REVOKED: says it was withdrawn, offers Serve and crisis, no self-attest', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(new ApiError(403, 'VERIFICATION_REVOKED', 'revoked'));
    renderVerify();
    await sendWith(user);
    expect(
      await screen.findByRole('heading', { name: 'Your confirmation was withdrawn' }),
    ).toBeInTheDocument();
    expectHelpOthers();
    expect(screen.queryByRole('button', { name: 'Tell us you served' })).toBeNull();
  });

  it('a REVOKED standing shows no form and no retry', async () => {
    client.GET.mockResolvedValue(me('REVOKED'));
    renderVerify();
    expect(
      await screen.findByRole('heading', { name: 'Your confirmation was withdrawn' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button', { name: /try|tell us/i })).toBeNull();
    expectHelpOthers();
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

describe('Verify self-attestation (D-016 fallback)', () => {
  it('records it with an Idempotency-Key and no details, then continues', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValue(attested);
    renderVerify('/request?category=FOOD');
    await screen.findByLabelText('First name');
    await tellUs(user);
    const heading = screen.getByRole('heading', { name: 'Tell us you served' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(
      screen.getByText(
        "SUAS help requests are for Veterans of the U.S. armed forces. We won't check this with VA.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('I am a Veteran of the U.S. armed forces.')).toBeInTheDocument();
    expect(screen.queryByRole('form')).toBeNull();
    expect(client.POST).not.toHaveBeenCalled();

    await user.dblClick(screen.getByRole('button', { name: 'Yes, I served' }));
    expect(
      await screen.findByRole('heading', { name: /Thanks\. You can ask for help now\./ }),
    ).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledTimes(1);
    expect(client.POST).toHaveBeenCalledWith(SELF_ATTEST, {
      params: { header: { 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) as string } },
    });
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute(
      'href',
      '/request?category=FOOD',
    );
    expect(screen.queryByText(/VA confirmed/)).toBeNull();
  });

  it('"Go back" returns to the notice and the filled form', async () => {
    const user = userEvent.setup();
    renderVerify();
    await screen.findByLabelText('First name');
    await fillForm(user);
    await tellUs(user);
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(
      screen.getByRole('region', { name: 'Before you send anything to VA' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Synthetic');
  });

  it('is offered after the attempt limit, which does not apply to it', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValueOnce(new ApiError(429, 'VERIFICATION_ATTEMPT_LIMIT', 'limit'));
    client.POST.mockResolvedValueOnce(attested);
    renderVerify();
    await sendWith(user);
    await screen.findByRole('heading', { name: "You've reached the limit for VA checks" });
    await tellUs(user);
    await user.click(screen.getByRole('button', { name: 'Yes, I served' }));
    expect(
      await screen.findByRole('heading', { name: /Thanks\. You can ask for help now\./ }),
    ).toBeInTheDocument();
    expect(client.POST.mock.calls[1]?.[0]).toBe(SELF_ATTEST);
  });

  it('a SELF_ATTESTATION standing shows the thanks view, not "VA confirmed"', async () => {
    client.GET.mockResolvedValue({ data: { id_verification: attested.data } });
    renderVerify();
    expect(
      await screen.findByRole('heading', { name: /Thanks\. You can ask for help now\./ }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/VA confirmed/)).toBeNull();
  });

  it('403 VERIFICATION_REVOKED shows the withdrawn view', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValue(new ApiError(403, 'VERIFICATION_REVOKED', 'revoked'));
    renderVerify();
    await screen.findByLabelText('First name');
    await tellUs(user);
    await user.click(screen.getByRole('button', { name: 'Yes, I served' }));
    expect(
      await screen.findByRole('heading', { name: 'Your confirmation was withdrawn' }),
    ).toBeInTheDocument();
  });

  it('a 409 IDEMPOTENCY_CONFLICT says to try again and the next press takes a new key', async () => {
    const user = userEvent.setup();
    client.POST.mockRejectedValueOnce(new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'conflict'));
    client.POST.mockResolvedValueOnce(attested);
    renderVerify();
    await screen.findByLabelText('First name');
    await tellUs(user);
    await user.click(screen.getByRole('button', { name: 'Yes, I served' }));
    expect(
      await screen.findByText("We couldn't save that just now. Wait a moment, then try again."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes, I served' }));
    await screen.findByRole('heading', { name: /Thanks\. You can ask for help now\./ });
    expect(sentKey(1)).not.toBe(sentKey(0));
  });
});
