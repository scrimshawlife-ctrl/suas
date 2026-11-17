import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
