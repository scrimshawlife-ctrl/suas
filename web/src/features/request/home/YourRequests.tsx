import { Link } from 'react-router';
import { paths } from '../../../app/paths';
import { ChevronRightIcon } from '../../../components/icons';
import { Card } from '../../../components/Card';
import { useServiceRequests } from '../../../api/service-requests';
import { RequestRow } from './RequestRow';

const SHOWN = 3;

/** "Your requests": the newest few, each a link to its status page, and "See all" when more exist. */
export function YourRequests() {
  const requests = useServiceRequests('requested', { limit: 10 });
  const all = requests.data?.service_requests ?? [];
  const items = all.slice(0, SHOWN);
  const hasMore = all.length > SHOWN || (requests.data?.next_cursor ?? null) !== null;
  return (
    <Card aria-labelledby="your-requests" padding="md" className="pb-3">
      <h2 id="your-requests" className="mb-1.5 text-20 font-bold">
        Your requests
      </h2>
      {requests.isPending ? (
        <p role="status" className="py-3.5 text-slate">
          Loading…
        </p>
      ) : requests.isError ? (
        <p className="py-3.5 text-slate">
          We could not load your requests. Reload the page to try again.
        </p>
      ) : items.length === 0 ? (
        <p className="py-3.5 text-slate">You have not made a request yet.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <RequestRow key={item.service_request_id} item={item} />
          ))}
        </ul>
      )}
      {hasMore ? (
        <Link
          to={paths.requests}
          className="flex min-h-12 items-center justify-between border-t border-line font-bold no-underline"
        >
          See all
          <ChevronRightIcon />
        </Link>
      ) : null}
    </Card>
  );
}
