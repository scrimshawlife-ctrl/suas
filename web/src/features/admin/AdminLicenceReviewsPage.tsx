import { Link } from 'react-router';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { StatusChip } from '../../components/StatusChip';
import { useLicenceReviews } from './api';
import { sentAgo, statusChip } from './licence-labels';
import { QueryNotice } from './QueryNotice';

/**
 * The licence review queue (suas-specs #73 R10.1 proposal, L5.1): open reviews oldest first, each
 * with its age, state and a dispute marker only, never a name.
 */
export default function AdminLicenceReviewsPage() {
  const query = useLicenceReviews();
  const items = query.data?.pages.flatMap((page) => page.reviews) ?? [];

  return (
    <>
      <title>Licence reviews · SUAS Admin</title>
      <div className="flex flex-col gap-1">
        <h1 className="heading text-40 max-sm:text-32">Licence reviews</h1>
        <p className="text-slate">
          Veterans VA could not confirm, who sent their licence instead. Oldest first. Reviews about
          you, reviews you stepped back from, and disputes of reviews you decided are not listed.
        </p>
      </div>

      <Card as="div" padding="none" aria-busy={query.isFetching}>
        {query.isPending ? (
          <p role="status" className="p-4 text-slate">
            Loading…
          </p>
        ) : query.isError ? (
          <div className="p-4">
            <QueryNotice
              error={query.error}
              what="licence reviews"
              onRetry={() => void query.refetch()}
            />
          </div>
        ) : items.length === 0 ? (
          <p className="p-4 text-slate">No licences are waiting for review.</p>
        ) : (
          <ul>
            {items.map((item) => {
              const chip = statusChip(item.status);
              return (
                <li
                  key={item.review_id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-4 py-3 last:border-b-0"
                >
                  <Link
                    to={paths.adminLicenceReview(item.review_id)}
                    className="inline-flex min-h-11 items-center font-bold"
                  >
                    Licence review, {sentAgo(item.submitted_at).toLowerCase()}
                  </Link>
                  <StatusChip kind={chip.kind}>{chip.text}</StatusChip>
                  {item.is_dispute ? <StatusChip kind="warn">Dispute</StatusChip> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {query.hasNextPage ? (
        <div>
          <Button
            variant="secondary"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
          </Button>
        </div>
      ) : null}
    </>
  );
}
