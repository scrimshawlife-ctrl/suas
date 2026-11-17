import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { LicenceDecisionDialogs } from './LicenceDecisionDialogs';
import { useLicenceDecision, type LicenceDecision } from './useLicenceDecision';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const id = '22222222-2222-4222-8222-222222222222';
const conflictId = '33333333-3333-4333-8333-333333333333';
const command = (name: string) => `/api/v0/admin/licence-reviews/{id}/commands/${name}`;
const review = {
  review_id: id,
  status: 'AWAITING_REVIEW',
  images: { front: true, back: true, selfie: true },
  conflicting_review: { review_id: conflictId, status: 'APPROVED' },
};

type Dialog = NonNullable<LicenceDecision['dialog']>;

/** The page's wiring, reduced to the hook and its dialogs with one dialog opened. */
function Harness({ open, onRecused }: { open: Dialog; onRecused: () => void }) {
  const decision = useLicenceDecision(id);
  const { setDialog } = decision;
  const loaded = decision.query.isSuccess;
  useEffect(() => {
    if (loaded) setDialog(open);
  }, [loaded, open, setDialog]);
  return <LicenceDecisionDialogs decision={decision} onRecused={onRecused} />;
}

function renderDialog(open: Dialog) {
  const onRecused = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Harness open={open} onRecused={onRecused} />
    </QueryClientProvider>,
  );
  return { onRecused, user: userEvent.setup() };
}

beforeEach(() => {
  client.GET.mockReset();
  client.POST.mockReset();
  client.GET.mockResolvedValue({ data: review });
});

describe('LicenceDecisionDialogs', () => {
  it.each([
    ['approve', 'Approve this licence?'],
    ['confirm', 'Confirm this approval?'],
    ['decline', 'Decline this licence?'],
    ['recuse', 'Step back from this review?'],
    ['revoke', 'Revoke this approval?'],
    ['revoke_conflict', 'Revoke this approval?'],
  ] as const)('opens only the %s dialog', async (open, title) => {
    renderDialog(open);
    expect(await screen.findByRole('dialog', { name: title })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('decline asks for a reason before it sends, then sends the chosen one', async () => {
    client.POST.mockResolvedValue({ data: { ...review, status: 'DECLINED' } });
    const { user } = renderDialog('decline');
    const dialog = await screen.findByRole('dialog', { name: 'Decline this licence?' });
    await user.click(within(dialog).getByRole('button', { name: 'Decline licence' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();

    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'EXPIRED');
    expect(within(dialog).queryByText('Choose a reason.')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Decline licence' }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        command('decline'),
        expect.objectContaining({ body: { reason: 'EXPIRED' } }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('revoke asks for a reason before it sends, then sends the chosen one', async () => {
    client.POST.mockResolvedValue({ data: { ...review, status: 'REVOKED' } });
    const { user } = renderDialog('revoke');
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this approval?' });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke approval' }));
    expect(within(dialog).getByText('Choose a reason.')).toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('radio', { name: /Fraud/ }));
    expect(within(dialog).queryByText('Choose a reason.')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Revoke approval' }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        command('revoke'),
        expect.objectContaining({ params: { path: { id } }, body: { reason: 'FRAUD' } }),
      ),
    );
  });

  it('a failed approve shows the plain-words error and stays open for a retry', async () => {
    client.POST.mockRejectedValue(new ApiError(409, 'LICENCE_REVIEW_DECIDED', 'x'));
    const { user } = renderDialog('approve');
    const dialog = await screen.findByRole('dialog', { name: 'Approve this licence?' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve licence' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This review was already decided. The page now shows its current state.',
    );
    expect(within(dialog).getByRole('button', { name: 'Approve licence' })).toBeEnabled();
  });

  it('a failed revoke of the conflicting review shows that command’s error', async () => {
    client.POST.mockRejectedValue(new ApiError(500, 'INTERNAL', 'x'));
    const { user } = renderDialog('revoke_conflict');
    const dialog = await screen.findByRole('dialog', { name: 'Revoke this approval?' });
    await user.click(within(dialog).getByRole('radio', { name: /Review error/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Revoke approval' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That did not go through. Check your connection and try again.',
    );
    expect(client.POST).toHaveBeenCalledWith(
      command('revoke'),
      expect.objectContaining({ params: { path: { id: conflictId } } }),
    );
  });

  it('calls onRecused once after a recuse succeeds', async () => {
    client.POST.mockResolvedValue({ data: undefined });
    const { user, onRecused } = renderDialog('recuse');
    const dialog = await screen.findByRole('dialog', { name: 'Step back from this review?' });
    await user.click(within(dialog).getByRole('button', { name: 'Step back' }));
    await waitFor(() => expect(onRecused).toHaveBeenCalledTimes(1));
  });

  it('does not call onRecused when the recuse fails, and says why', async () => {
    client.POST.mockRejectedValue(new ApiError(403, 'REVIEWER_RECUSED', 'x'));
    const { user, onRecused } = renderDialog('recuse');
    const dialog = await screen.findByRole('dialog', { name: 'Step back from this review?' });
    await user.click(within(dialog).getByRole('button', { name: 'Step back' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'You stepped back from this review, so you cannot decide it.',
    );
    expect(onRecused).not.toHaveBeenCalled();
  });
});
