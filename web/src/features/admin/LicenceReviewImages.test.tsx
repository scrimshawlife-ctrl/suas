import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { queryKeys } from '../../api/keys';
import { LicenceReviewImages } from './LicenceReviewImages';

const client = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const id = '22222222-2222-4222-8222-222222222222';
const images = { front: true, back: false, selfie: false };
const imageKey = [...queryKeys.adminLicenceReviews.detail(id), 'image', 'front'];
const create = vi.fn(() => 'blob:front');
const revoke = vi.fn();

function renderImages() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <LicenceReviewImages id={id} images={images} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

beforeEach(() => {
  client.GET.mockReset();
  create.mockClear();
  revoke.mockClear();
  URL.createObjectURL = create;
  URL.revokeObjectURL = revoke;
});

describe('LicenceReviewImages object URLs', () => {
  it('revokes the object URL when the page closes', async () => {
    client.GET.mockResolvedValue({ data: new Blob(['jpeg'], { type: 'image/jpeg' }) });
    const { unmount } = renderImages();
    expect(await screen.findByRole('img', { name: 'Front of the licence' })).toHaveAttribute(
      'src',
      'blob:front',
    );
    unmount();
    expect(revoke).toHaveBeenCalledWith('blob:front');
  });

  it('closing during the fetch makes no object URL and keeps no image', async () => {
    let answer: (value: { data: Blob }) => void = () => undefined;
    client.GET.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { unmount, queryClient } = renderImages();
    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    unmount();
    answer({ data: new Blob(['jpeg'], { type: 'image/jpeg' }) });
    await waitFor(() =>
      expect(queryClient.getQueryCache().find({ queryKey: imageKey })).toBeUndefined(),
    );
    expect(create).not.toHaveBeenCalled();
  });

  // The URL is made in an effect keyed on the fetched blob, so re-renders while the fetch runs,
  // or after the image shows, make no second URL; the one URL is revoked once on close.
  it('re-renders during and after the fetch make one object URL, revoked once on close', async () => {
    let answer: (value: { data: Blob }) => void = () => undefined;
    client.GET.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { rerender, unmount, queryClient } = renderImages();
    const renderAgain = () =>
      rerender(
        <QueryClientProvider client={queryClient}>
          <LicenceReviewImages id={id} images={{ ...images }} />
        </QueryClientProvider>,
      );
    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    renderAgain();
    answer({ data: new Blob(['jpeg'], { type: 'image/jpeg' }) });
    await screen.findByRole('img', { name: 'Front of the licence' });
    renderAgain();
    renderAgain();
    expect(revoke).not.toHaveBeenCalled();
    unmount();
    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('a failed fetch shows a retry notice and makes no object URL', async () => {
    client.GET.mockRejectedValue(new ApiError(500, 'INTERNAL', 'x'));
    renderImages();
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load this image.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('Try again after a failed fetch shows the image with one object URL, revoked on close', async () => {
    client.GET.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'x')).mockResolvedValueOnce({
      data: new Blob(['jpeg'], { type: 'image/jpeg' }),
    });
    const { unmount } = renderImages();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('img', { name: 'Front of the licence' })).toHaveAttribute(
      'src',
      'blob:front',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    unmount();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
