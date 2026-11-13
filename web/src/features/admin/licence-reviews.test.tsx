import { screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import AdminLicenceReviewPage from './AdminLicenceReviewPage';
import AdminLicenceReviewsPage from './AdminLicenceReviewsPage';
import { renderAt } from './test-utils';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const id = '22222222-2222-4222-8222-222222222222';
const ME = '44444444-4444-4444-8444-444444444444';
const OTHER_ADMIN = '55555555-5555-4555-8555-555555555555';
const DETAIL = '/api/v0/admin/licence-reviews/{id}';
const IMAGE = '/api/v0/admin/licence-reviews/{id}/images/{side}';
const command = (name: string) => `/api/v0/admin/licence-reviews/{id}/commands/${name}`;
const field = (value: string | null, source: string | null = 'barcode', agreed = true) => ({
  value,
  source,
  agreed,
});

type Review = Record<string, unknown>;

const base: Review = {
  review_id: id,
  status: 'AWAITING_REVIEW',
  submitted_at: '2026-11-11T10:00:00Z',
  decided_at: null,
  notice_version: 'licence-notice-v1',
  is_dispute: false,
  dispute_of_review_id: null,
  images: { front: true, back: true, selfie: true },
  reading: {
    fields: {
      first_name: field('SAMPLE'),
      last_name: field('VETERAN'),
      issue_date: field('2024-01-02', 'front', false),
      expiry_date: field('2032-01-02'),
      issuing_state: field('CA'),
    },
    veteran: { value: 'yes', barcode: 'yes', front: 'yes', source: 'barcode', agreed: true },
    consistency_checks: {
      not_expired: 'pass',
      issued_before_expiry: 'pass',
      plausible_age: 'pass',
      veteran_designation_agrees: 'pass',
    },
  },
  identity_match: 'YES',
  fingerprint_in_use: false,
  failure_class: null,
  decline_reason: null,
  revoke_reason: null,
  approved_by: null,
  approved_at: null,
  confirmed_by: null,
  confirmed_at: null,
  declined_by: null,
  revoked_by: null,
  viewer: { can_approve: true, can_confirm: false, can_decline: true, can_revoke: false },
  conflicting_review: null,
};
const reviewWith = (over: Review = {}) => ({ ...base, ...over });

function serve(review: Review) {
  client.GET.mockImplementation((path: string) => {
    if (path === IMAGE)
      return Promise.resolve({ data: new Blob(['jpeg'], { type: 'image/jpeg' }) });
    if (path === DETAIL) return Promise.resolve({ data: review });
    if (path === '/api/v0/veterans/me') return Promise.resolve({ data: { user_id: ME } });
    return Promise.resolve({ data: { reviews: [], limit: 20, next_cursor: null } });
  });
}

function renderReview() {
  return renderAt(
    [
      { path: '/admin/licence-reviews/:id', element: <AdminLicenceReviewPage /> },
      { path: '/admin/licence-reviews', element: <p>queue</p> },
    ],
    [`/admin/licence-reviews/${id}`],
  );
}

const sayYes = async (user: UserEvent) =>
  user.click(await screen.findByRole('radio', { name: /Yes, I can see it/ }));
async function tickAll(user: UserEvent) {
  for (const box of screen.getAllByRole('checkbox')) await user.click(box);
}
const sentHeaders = (call = 0) =>
  (client.POST.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers;

beforeEach(() => {
  tokenStore.setToken('tok', { mfaElevated: true });
  client.GET.mockReset();
  client.POST.mockReset();
  URL.createObjectURL = () => 'blob:licence';
  URL.revokeObjectURL = () => {};
});

describe('Licence review queue (L5.1)', () => {
  it('lists age, state and a dispute marker only, oldest first, never names', async () => {
    client.GET.mockResolvedValue({
      data: {
        reviews: [
          {
            review_id: 'a',
            status: 'AWAITING_REVIEW',
            submitted_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
            is_dispute: false,
          },
          {
            review_id: 'b',
            status: 'AWAITING_CONFIRMATION',
            submitted_at: new Date().toISOString(),
            is_dispute: true,
          },
        ],
        limit: 20,
        next_cursor: null,
      },
    });
    renderAt([{ path: '/q', element: <AdminLicenceReviewsPage /> }], ['/q']);
    const rows = await screen.findAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Licence review, sent 3 hours ago');
    expect(rows[0]).toHaveTextContent('To review');
    expect(rows[1]).toHaveTextContent('To confirm');
    expect(within(rows[1] as HTMLElement).getByText('Dispute')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByRole('link')).toHaveAttribute(
      'href',
      '/admin/licence-reviews/a',
    );
  });
});

describe('Licence review page (L5.2 to L5.8)', () => {
  it('shows the three images first and nothing read until the designation question is answered', async () => {
    serve(reviewWith());
    const user = userEvent.setup();
    renderReview();
    expect(await screen.findByRole('img', { name: 'Front of the licence' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Back of the licence' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Selfie' })).toBeInTheDocument();
    expect(client.GET).toHaveBeenCalledWith(IMAGE, expect.objectContaining({ parseAs: 'blob' }));
    // No reading, flag or check before the answer, and never a download control.
    expect(screen.queryByText('SAMPLE')).not.toBeInTheDocument();
    expect(screen.queryByText(/Matches the details given to VA/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download/i })).not.toBeInTheDocument();

    await sayYes(user);
    expect(screen.getByText('SAMPLE')).toBeInTheDocument();
    expect(screen.getByText('Check this')).toBeInTheDocument();
    expect(screen.getByText('From the printed front. The two reads disagreed')).toBeInTheDocument();
    expect(
      screen.getByRole('heading', {
        name: 'Consistency checks: these do not show the card is genuine',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Matches the details given to VA: yes.')).toBeInTheDocument();
    expect(screen.getByText('This licence is not on any approved review.')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  });

  it('"No" goes straight to a decline with NO_VETERAN_DESIGNATION', async () => {
    serve(reviewWith());
    client.POST.mockResolvedValue({
      data: reviewWith({
        status: 'DECLINED',
        decline_reason: 'NO_VETERAN_DESIGNATION',
        reading: null,
        images: { front: false, back: false, selfie: false },
      }),
    });
    const user = userEvent.setup();
    renderReview();
    await user.click(await screen.findByRole('radio', { name: /^No/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Decline this licence?' });
    expect(within(dialog).getByLabelText('Reason')).toHaveValue('NO_VETERAN_DESIGNATION');
    await user.click(within(dialog).getByRole('button', { name: 'Decline licence' }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        command('decline'),
        expect.objectContaining({ body: { reason: 'NO_VETERAN_DESIGNATION' } }),
      ),
    );
    expect(sentHeaders()['Idempotency-Key']).toEqual(expect.any(String));
    expect(await screen.findByText(/Declined: No Veteran designation/)).toBeInTheDocument();
  });

  it('approve needs every check ticked, then sends the designation and checklist as true', async () => {
    serve(reviewWith());
    client.POST.mockResolvedValue({
      data: reviewWith({
        status: 'AWAITING_CONFIRMATION',
        approved_by: ME,
        viewer: { ...(base.viewer as object), can_approve: false },
      }),
    });
    const user = userEvent.setup();
    renderReview();
    await sayYes(user);
    const approve = screen.getByRole('button', { name: 'Approve (first review)' });
    expect(approve).toHaveAttribute('aria-disabled', 'true');
    await tickAll(user);
    await user.click(approve);
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Approve this licence?' })).getByRole(
        'button',
        { name: 'Approve licence' },
      ),
    );
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        command('approve'),
        expect.objectContaining({
          params: { path: { id } },
          body: {
            designation_visible: true,
            checklist: { selfie_matches: true, security_features: true, whole_card: true },
          },
        }),
      ),
    );
  });

  it('the first admin is told a different admin must confirm, with no Confirm button', async () => {
    serve(reviewWith({ status: 'AWAITING_CONFIRMATION', approved_by: ME }));
    const user = userEvent.setup();
    renderReview();
    await sayYes(user);
    expect(
      await screen.findByText('You approved this review, so a different admin must confirm it.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm approval' })).not.toBeInTheDocument();
  });

  it('a second admin confirms; a 403 SECOND_REVIEWER_REQUIRED is explained in the dialog', async () => {
    serve(
      reviewWith({
        status: 'AWAITING_CONFIRMATION',
        approved_by: OTHER_ADMIN,
        viewer: { can_approve: false, can_confirm: true, can_decline: true, can_revoke: false },
      }),
    );
    client.POST.mockRejectedValueOnce(new ApiError(403, 'SECOND_REVIEWER_REQUIRED', 'x'));
    const user = userEvent.setup();
    renderReview();
    await sayYes(user);
    expect(screen.getByText(/First approval by admin 5555/)).toBeInTheDocument();
    await tickAll(user);
    await user.click(screen.getByRole('button', { name: 'Confirm approval' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm this approval?' });
    await user.click(within(dialog).getByRole('button', { name: 'Confirm approval' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You approved this review, so a different admin must confirm it.',
    );
    expect(client.POST.mock.calls[0]?.[0]).toBe(command('confirm'));
  });

  it.each([
    [{ identity_match: 'NO' }, /does not match the details given to VA/],
    [
      { identity_match: 'UNKNOWN' },
      /does not match the details given to VA, or they were not read/,
    ],
    [{ fingerprint_in_use: null }, /number or state wasn't read/],
    [{ fingerprint_in_use: true }, /already approved for another account/],
  ])('%o cannot be approved, and says why; decline stays open', async (over, words) => {
    serve(reviewWith(over));
    const user = userEvent.setup();
    renderReview();
    await sayYes(user);
    await tickAll(user);
    expect(screen.getByText(words)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve (first review)' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Decline' })).not.toHaveAttribute('aria-disabled');
  });

  it('decline needs a reason, and offers every L5.7 reason', async () => {
    serve(reviewWith());
    const user = userEvent.setup();
    renderReview();
    await sayYes(user);
    await user.click(screen.getByRole('button', { name: 'Decline' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decline this licence?' });
    await user.click(within(dialog).getByRole('button', { name: 'Decline licence' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeInTheDocument();
    expect(within(dialog).getAllByRole('option')).toHaveLength(8);
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('recuse confirms first, then leaves for the queue', async () => {
    serve(reviewWith());
    client.POST.mockResolvedValue({ data: undefined });
    const user = userEvent.setup();
    const { router } = renderReview();
    await sayYes(user);
    await user.click(screen.getByRole('button', { name: 'Step back from this review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Step back from this review?' });
    await user.click(within(dialog).getByRole('button', { name: 'Step back' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/licence-reviews'));
    expect(client.POST.mock.calls[0]?.[0]).toBe(command('recuse'));
  });

  it('a dispute shows the conflicting review record and can revoke it with a reason', async () => {
    serve(
      reviewWith({
        is_dispute: true,
        dispute_of_review_id: 'old',
        fingerprint_in_use: true,
        conflicting_review: {
          review_id: '33333333-3333-4333-8333-333333333333',
          status: 'APPROVED',
          submitted_at: '2026-10-01T10:00:00Z',
          decided_at: '2026-10-02T10:00:00Z',
          approved_by: OTHER_ADMIN,
          confirmed_by: '66666666-6666-4666-8666-666666666666',
          identity_match: 'YES',
          notice_version: 'licence-notice-v1',
        },
      }),
    );
    client.POST.mockResolvedValue({ data: { status: 'REVOKED' } });
    const user = userEvent.setup();
    renderReview();
    expect(await screen.findByText('Dispute')).toBeInTheDocument();
    await sayYes(user);
    const record = screen.getByRole('region', { name: 'Dispute' });
    expect(record).toHaveTextContent(OTHER_ADMIN);
    expect(record).toHaveTextContent('licence-notice-v1');
    expect(record).toHaveTextContent('Its images were deleted');
    await user.click(within(record).getByRole('button', { name: 'Revoke that approval' }));
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this approval?' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke approval' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: /Review error/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Revoke approval' }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        command('revoke'),
        expect.objectContaining({
          params: { path: { id: '33333333-3333-4333-8333-333333333333' } },
          body: { reason: 'REVIEW_ERROR' },
        }),
      ),
    );
  });

  it.each([
    ['SELF_REVIEW_FORBIDDEN', 'This review is about your own account, so you cannot decide it.'],
    ['REVIEWER_RECUSED', 'You stepped back from this review, so you cannot decide it.'],
  ])('a 403 %s when opening says so in plain words', async (code, words) => {
    client.GET.mockRejectedValue(new ApiError(403, code, 'x'));
    renderReview();
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
  });

  it('a decided review shows only its record: no images, reading or decision buttons', async () => {
    serve(
      reviewWith({
        status: 'APPROVED',
        decided_at: '2026-11-11T12:00:00Z',
        reading: null,
        images: { front: false, back: false, selfie: false },
      }),
    );
    renderReview();
    expect(await screen.findByText(/Approved and confirmed/)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke this approval' })).not.toBeInTheDocument();
  });
});
