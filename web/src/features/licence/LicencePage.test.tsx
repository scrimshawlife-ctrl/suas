import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import LicencePage from './LicencePage';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const LICENCE = '/api/v0/veterans/me/verification/licence';
const DISPUTE = '/api/v0/veterans/me/verification/licence/{review_id}/commands/dispute';

type Review = Record<string, unknown> | null;

const reviewOf = (over: Record<string, unknown>) => ({
  review_id: 'r1',
  status: 'READING',
  decline_reason: null,
  failure_class: null,
  disputable: false,
  dispute_of_review_id: null,
  submitted_at: '2026-11-11T10:00:00Z',
  decided_at: null,
  ...over,
});

function serve(
  review: Review,
  offered = true,
  standing = 'NOT_CONFIRMED',
  method = 'VA_VETERAN_STATUS',
) {
  client.GET.mockImplementation((path: string) =>
    Promise.resolve({
      data:
        path === LICENCE
          ? {
              offered,
              notice_version: 'licence-notice-v1',
              review: review === null ? null : reviewOf(review),
            }
          : {
              id_verification: {
                method,
                status: standing,
                not_confirmed_reason: 'NOT_TITLE_38',
                verified_at: null,
              },
            },
    }),
  );
}

// jsdom has no camera or image decoder: the page takes these seams; shrinking is tested apart.
const prepare = (file: File) => Promise.resolve(new Blob([file.name], { type: 'image/jpeg' }));
const stopped = vi.fn();
const openCamera = vi.fn(() =>
  Promise.resolve({ getTracks: () => [{ stop: stopped }] } as unknown as MediaStream),
);
const grabFrame = () => Promise.resolve(new Blob(['selfie'], { type: 'image/jpeg' }));

function renderLicence() {
  tokenStore.setToken('tok');
  const router = createMemoryRouter(
    [
      {
        path: '/verify/licence',
        element: <LicencePage prepare={prepare} openCamera={openCamera} grabFrame={grabFrame} />,
      },
      { path: '/verify', element: <p>verify page</p> },
      { path: '/request', element: <p>request page</p> },
    ],
    { initialEntries: ['/verify/licence'] },
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

const photo = (name: string) => new File([name], name, { type: 'image/jpeg' });

async function addCaptures(user: UserEvent) {
  await user.upload(await screen.findByLabelText(/Front of your licence/), photo('front.jpg'));
  await user.upload(screen.getByLabelText(/Back of your licence/), photo('back.jpg'));
  await user.click(screen.getByRole('button', { name: 'Turn on the camera' }));
  await user.click(await screen.findByRole('button', { name: 'Take selfie' }));
  await screen.findByRole('img', { name: 'Your selfie, as it will be sent' });
}
const sendForReview = (user: UserEvent) =>
  user.click(screen.getByRole('button', { name: 'Send for review' }));

/** L10, R9.6: the crisis card and the help-others links stay beside every state. */
function expectCrisisAndHelp({ help = true } = {}) {
  expect(screen.getByRole('link', { name: 'Veterans Crisis Line: Text 838255' })).toHaveAttribute(
    'href',
    'sms:838255',
  );
  expect(screen.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
  if (help) {
    expect(screen.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
    expect(screen.getByRole('link', { name: 'More crisis options' })).toHaveAttribute(
      'href',
      '/crisis',
    );
  }
}

beforeEach(() => {
  tokenStore.clear();
  window.localStorage.clear();
  window.sessionStorage.clear();
  client.GET.mockReset();
  client.POST.mockReset();
  openCamera.mockClear();
  stopped.mockClear();
  // jsdom has no object URLs or media playback; the preview only needs a string.
  URL.createObjectURL = vi.fn(() => 'blob:preview');
  URL.revokeObjectURL = vi.fn();
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
});

describe('Licence page form (L2)', () => {
  it('shows licence-notice-v1 before the captures, and the selfie has no file picker', async () => {
    serve(null);
    renderLicence();
    const notice = await screen.findByRole('heading', {
      name: 'Before you send photos of your licence',
    });
    const front = screen.getByLabelText(/Front of your licence/);
    // The notice comes before any capture (L2.1).
    expect(notice.compareDocumentPosition(front) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/a second SUAS admin confirms any approval/i)).toBeInTheDocument();
    expect(screen.getByText(/after 30 days at most/)).toBeInTheDocument();
    expect(screen.getByText(/no connection to any DMV or to VA/)).toBeInTheDocument();
    // Front and back take files; the selfie is camera only (L2.2).
    const inputs = document.body.querySelectorAll('input[type="file"]');
    expect(inputs).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Turn on the camera' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
    expectCrisisAndHelp();
  });

  it('asks for each missing capture and focuses the first', async () => {
    serve(null);
    const user = userEvent.setup();
    renderLicence();
    await screen.findByRole('button', { name: 'Send for review' });
    await sendForReview(user);
    expect(
      await screen.findByText('Add a photo of the front of your licence.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Add a photo of the back of your licence.')).toBeInTheDocument();
    expect(screen.getByText('Take a selfie with your camera.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/Front of your licence/)).toHaveFocus());
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('a refused camera explains why, and still offers no file picker', async () => {
    serve(null);
    openCamera.mockRejectedValueOnce(new Error('NotAllowedError'));
    const user = userEvent.setup();
    renderLicence();
    await user.click(await screen.findByRole('button', { name: 'Turn on the camera' }));
    expect(await screen.findByText(/We need your camera for the selfie/)).toBeInTheDocument();
    expect(document.body.querySelectorAll('input[type="file"]')).toHaveLength(2);
  });

  it('sends the notice version and three JPEGs once, stops the camera, then shows reading', async () => {
    serve(null);
    client.POST.mockResolvedValue({ data: reviewOf({ status: 'READING' }) });
    const user = userEvent.setup();
    const { router, queryClient } = renderLicence();
    await addCaptures(user);
    expect(stopped).toHaveBeenCalled();
    serve({ status: 'READING' });
    await user.dblClick(screen.getByRole('button', { name: 'Send for review' }));

    expect(
      await screen.findByRole('heading', { name: "We're reading your licence" }),
    ).toHaveFocus();
    expect(client.POST).toHaveBeenCalledTimes(1);
    const [path, options] = client.POST.mock.calls[0] as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(path).toBe(LICENCE);
    expect(options.body).toEqual({
      notice_version: 'licence-notice-v1',
      front: { content_type: 'image/jpeg', data_base64: btoa('front.jpg') },
      back: { content_type: 'image/jpeg', data_base64: btoa('back.jpg') },
      selfie: { content_type: 'image/jpeg', data_base64: btoa('selfie') },
    });
    // No image bytes in storage, the address, the query cache or the mutation cache (§2).
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
    for (const image of ['front.jpg', 'back.jpg', 'selfie']) {
      expect(kept).not.toContain(btoa(image));
    }
    expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
    expectCrisisAndHelp();
  });

  it.each([
    [new ApiError(400, 'VALIDATION_FAILED', 'selfie'), 'We could not use these photos'],
    [new ApiError(413, 'HTTP_413', 'too large'), 'We could not use these photos'],
    [new ApiError(400, 'LICENCE_NOTICE_VERSION_REQUIRED', 'old'), 'This page is out of date'],
    [new ApiError(500, 'INTERNAL', 'boom'), 'Check your connection'],
  ])('a %s keeps the captures on the form with plain words', async (error, words) => {
    serve(null);
    client.POST.mockRejectedValue(error);
    const user = userEvent.setup();
    renderLicence();
    await addCaptures(user);
    await sendForReview(user);
    expect(await screen.findByText(new RegExp(words))).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Your selfie, as it will be sent' }),
    ).toBeInTheDocument();
  });

  it.each([
    [
      new ApiError(429, 'LICENCE_SUBMISSION_LIMIT', 'limit', 3600),
      "You've reached the limit for licence reviews",
    ],
    [new ApiError(503, 'ID_VERIFICATION_UNAVAILABLE', 'off'), 'Licence review is off right now'],
    [new ApiError(403, 'VERIFICATION_REVOKED', 'revoked'), 'Your confirmation was withdrawn'],
  ])('a refused send (%s) gets its own view with the crisis card', async (error, heading) => {
    serve(null);
    client.POST.mockRejectedValue(error);
    const user = userEvent.setup();
    renderLicence();
    await addCaptures(user);
    await sendForReview(user);
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send for review' })).not.toBeInTheDocument();
    expectCrisisAndHelp();
  });

  it('the 429 view says when, in the last 24 hours, never "today"', async () => {
    serve(null);
    client.POST.mockRejectedValue(new ApiError(429, 'LICENCE_SUBMISSION_LIMIT', 'limit', 3600));
    const user = userEvent.setup();
    renderLicence();
    await addCaptures(user);
    await sendForReview(user);
    const body = await screen.findByText(/most licence reviews allowed in the last 24 hours/);
    expect(body).toHaveTextContent(/You can send your licence again after \d{1,2}:\d{2}/);
    expect(body).not.toHaveTextContent(/today/i);
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
  });
});

describe('Licence page states (L4, L6)', () => {
  it.each([
    [{ status: 'READING' }, "We're reading your licence"],
    [{ status: 'AWAITING_REVIEW' }, 'A SUAS admin will check your licence'],
    [{ status: 'AWAITING_CONFIRMATION' }, 'A SUAS admin will check your licence'],
    [{ status: 'UNREADABLE', failure_class: 'TIMEOUT' }, 'Our licence reader is down'],
    [{ status: 'UNREADABLE', failure_class: 'NOT_A_LICENCE' }, "We couldn't read those photos"],
    [{ status: 'UNREADABLE', failure_class: 'PHOTOS_EXPIRED' }, 'Please send your photos again'],
    [{ status: 'UNREADABLE', failure_class: 'PHOTOS_GONE' }, 'Please send your photos again'],
    [
      { status: 'UNREADABLE', failure_class: 'NOT_SYNTHETIC' },
      'This version only reads sample licences',
    ],
    [
      { status: 'DECLINED', decline_reason: 'EXPIRED' },
      "We couldn't confirm your Veteran status from your licence",
    ],
    [{ status: 'REVOKED' }, 'Your licence approval was withdrawn'],
  ])('%o shows "%s" with the crisis card and help links', async (review, heading) => {
    serve(review);
    renderLicence();
    expect(await screen.findByRole('heading', { name: heading })).toBeInTheDocument();
    expectCrisisAndHelp();
  });

  it('the reader-down view uses the spec words, is not counted, and offers a retry', async () => {
    serve({ status: 'UNREADABLE', failure_class: 'NETWORK_ERROR' });
    renderLicence();
    expect(
      await screen.findByText('Our licence reader is down. Please try again later.'),
    ).toBeInTheDocument();
    expect(screen.getByText("This didn't use one of your tries.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('with the path closed, the reader-down view offers self-attestation only', async () => {
    serve({ status: 'UNREADABLE', failure_class: 'TIMEOUT' }, false);
    renderLicence();
    await screen.findByRole('heading', { name: 'Our licence reader is down' });
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tell us you served' })).toBeInTheDocument();
  });

  it('APPROVED: "You\'re confirmed" and Continue goes to Request help', async () => {
    serve({ status: 'APPROVED' }, false, 'VERIFIED', 'MANUAL_REVIEW');
    const user = userEvent.setup();
    const { router } = renderLicence();
    expect(await screen.findByRole('heading', { name: "You're confirmed" })).toBeInTheDocument();
    expect(screen.getByText(/A SUAS admin confirmed your Veteran status/)).toBeInTheDocument();
    expectCrisisAndHelp({ help: false });
    await user.click(screen.getByRole('link', { name: 'Continue' }));
    expect(router.state.location.pathname).toBe('/request');
  });

  it('DECLINED: the reason in plain words, not a finding, self-attest and a new submission', async () => {
    serve({ status: 'DECLINED', decline_reason: 'SELFIE_MISMATCH' });
    const user = userEvent.setup();
    const { router } = renderLicence();
    expect(
      await screen.findByText('The admin could not match your selfie to the photo on the licence.'),
    ).toBeInTheDocument();
    expect(screen.getByText('This is not a finding that you did not serve.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ask us to look again/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send your licence again' }));
    expect(await screen.findByRole('button', { name: 'Send for review' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tell us you served' }));
    expect(router.state.location.pathname).toBe('/verify');
    expect(router.state.location.state).toEqual({ choice: 'self_attest', from: '/request' });
  });

  it('ALREADY_USED: "ask us to look again" sends new captures to the dispute route', async () => {
    serve({ status: 'DECLINED', decline_reason: 'ALREADY_USED', disputable: true }, false);
    client.POST.mockResolvedValue({
      data: reviewOf({ review_id: 'r2', status: 'READING', dispute_of_review_id: 'r1' }),
    });
    const user = userEvent.setup();
    renderLicence();
    await user.click(
      await screen.findByRole('button', { name: 'If this is your licence, ask us to look again' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Ask us to look again' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Before you send photos of your licence' }),
    ).toBeInTheDocument();
    await addCaptures(user);
    serve({ review_id: 'r2', status: 'READING', dispute_of_review_id: 'r1' }, false);
    await sendForReview(user);
    expect(
      await screen.findByRole('heading', { name: "We're reading your licence" }),
    ).toBeInTheDocument();
    const [path, options] = client.POST.mock.calls[0] as [
      string,
      { params: { path: { review_id: string } }; body: { notice_version: string } },
    ];
    expect(path).toBe(DISPUTE);
    expect(options.params.path.review_id).toBe('r1');
    expect(options.body.notice_version).toBe('licence-notice-v1');
  });

  it('a person not offered the path, with nothing to show, goes back to Verify', async () => {
    serve(null, false);
    const { router } = renderLicence();
    expect(await screen.findByText('verify page')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/verify');
  });

  it('a REVOKED standing shows the withdrawn view with no form or self-attestation', async () => {
    serve({ status: 'APPROVED' }, false, 'REVOKED', 'MANUAL_REVIEW');
    renderLicence();
    expect(
      await screen.findByRole('heading', { name: 'Your confirmation was withdrawn' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tell us you served' })).not.toBeInTheDocument();
    expectCrisisAndHelp();
  });
});
