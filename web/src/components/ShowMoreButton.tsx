import { cn } from '../lib/cn';
import { Button } from './Button';

/** The parts of a TanStack infinite query that the button reads. */
export interface PagedList {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage: () => Promise<unknown>;
}

/**
 * "Show more" under a list paged by `next_cursor`. Renders nothing on the last page. A failed
 * next page says so here; the rows already loaded stay as they are.
 */
export function ShowMoreButton({ list, className }: { list: PagedList; className?: string }) {
  if (!list.hasNextPage) return null;
  return (
    <div className={cn('flex flex-col items-start gap-2', className)}>
      {list.isFetchNextPageError ? (
        <p role="status" className="text-slate">
          Couldn&apos;t load more. Try again.
        </p>
      ) : null}
      <Button
        variant="secondary"
        size="small"
        disabled={list.isFetchingNextPage}
        onClick={() => void list.fetchNextPage()}
      >
        {list.isFetchingNextPage ? 'Loading…' : 'Show more'}
      </Button>
    </div>
  );
}
