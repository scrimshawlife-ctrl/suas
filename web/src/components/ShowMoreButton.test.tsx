import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShowMoreButton, type PagedList } from './ShowMoreButton';

const list = (overrides: Partial<PagedList> = {}): PagedList => ({
  hasNextPage: true,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  fetchNextPage: vi.fn(() => Promise.resolve()),
  ...overrides,
});

describe('ShowMoreButton', () => {
  it('says a failed next page failed and lets the person try again', async () => {
    const failed = list({ isFetchNextPageError: true });
    render(<ShowMoreButton list={failed} />);
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't load more. Try again.");
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(failed.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('shows no error line before a failure, and nothing on the last page', () => {
    const { rerender } = render(<ShowMoreButton list={list()} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    rerender(<ShowMoreButton list={list({ hasNextPage: false })} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
