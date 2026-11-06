import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CancelRequest } from './RequestActions';
import { renderScreen } from './test-utils';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../api/client', () => ({ api: { POST: post, GET: vi.fn() } }));

const ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  post.mockReset();
});

describe('CancelRequest', () => {
  it('opens on "Keep request active" and sends the fixed reason on confirm', async () => {
    post.mockResolvedValue({
      data: { service_request_id: ID, status: 'CANCELLED', replayed: false },
    });
    renderScreen(<CancelRequest requestId={ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    expect(await screen.findByRole('dialog', { name: 'Cancel this request?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep request active' })).toHaveFocus();

    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel request' }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, options] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/api/v0/service-requests/{id}/commands/{command}');
    expect(options.params).toEqual({ path: { id: ID, command: 'CANCEL' } });
    expect(options.body).toEqual({ reason: 'Cancelled by the requester' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('ignores Escape, Close and the backdrop while the cancel is pending', async () => {
    post.mockReturnValue(new Promise(() => undefined));
    renderScreen(<CancelRequest requestId={ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel request' }));
    await screen.findByRole('button', { name: 'Canceling…' });

    fireEvent.keyDown(document, { key: 'Escape' });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.mouseDown(dialog.parentElement as HTMLElement);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Canceling…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('closes on Keep request active without sending anything', async () => {
    renderScreen(<CancelRequest requestId={ID} />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep request active' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});
