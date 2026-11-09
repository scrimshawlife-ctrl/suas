import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { ReleaseDialog } from './ReleaseDialog';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

function open() {
  const handlers = { onClose: vi.fn(), onReleased: vi.fn() };
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ReleaseDialog serviceRequestId="r1" {...handlers} />
    </QueryClientProvider>,
  );
  return handlers;
}

const confirm = () => screen.getByRole('button', { name: /Confirm release|Releasing/ });
const keyOf = (call: number) =>
  (client.POST.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers[
    'Idempotency-Key'
  ];

beforeEach(() => {
  client.POST.mockReset();
  client.POST.mockResolvedValue({ data: {} });
});

describe('ReleaseDialog', () => {
  it('needs a reason before it can confirm, and bounds its length', async () => {
    open();
    const reason = screen.getByRole('textbox', { name: /Why are you releasing it/ });
    expect(screen.getByRole('dialog', { name: 'Release this request?' })).toBeInTheDocument();
    expect(reason).toBeRequired();
    expect(reason).toHaveAttribute('maxlength', '512');
    expect(confirm()).toHaveAttribute('aria-disabled', 'true');

    await userEvent.type(reason, '   ');
    await userEvent.click(confirm());
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('sends RELEASE with the trimmed reason and an Idempotency-Key, then reports it', async () => {
    const { onReleased } = open();
    await userEvent.type(screen.getByRole('textbox'), ' My car broke down. ');
    await userEvent.click(confirm());

    await waitFor(() => expect(onReleased).toHaveBeenCalledTimes(1));
    expect(client.POST).toHaveBeenCalledWith(
      '/api/v0/service-requests/{id}/commands/{command}',
      expect.objectContaining({
        params: { path: { id: 'r1', command: 'RELEASE' } },
        body: { reason: 'My car broke down.' },
        headers: { 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) as string },
      }),
    );
  });

  it('shows plain error copy, reuses the key for the same reason and renews it for a new one', async () => {
    client.POST.mockRejectedValue(new ApiError(500, 'INTERNAL', 'x'));
    const { onReleased } = open();
    const reason = screen.getByRole('textbox');
    await userEvent.type(reason, 'Cannot make it');
    await userEvent.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not go through.');

    await userEvent.click(confirm());
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(keyOf(1)).toBe(keyOf(0));

    await userEvent.type(reason, ' today');
    await userEvent.click(confirm());
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(3));
    expect(keyOf(2)).not.toBe(keyOf(0));
    expect(onReleased).not.toHaveBeenCalled();
  });

  it('says the step is not available when the status moved', async () => {
    client.POST.mockRejectedValue(new ApiError(409, 'ILLEGAL_TRANSITION', 'x'));
    open();
    await userEvent.type(screen.getByRole('textbox'), 'Cannot make it');
    await userEvent.click(confirm());
    expect(await screen.findByRole('alert')).toHaveTextContent("That step isn't available");
  });

  it('closes on Cancel without calling the API', async () => {
    const { onClose } = open();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(client.POST).not.toHaveBeenCalled();
  });
});
