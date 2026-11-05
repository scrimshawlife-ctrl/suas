import { Link } from 'react-router';
import { paths } from '../../../app/paths';
import { Card } from '../../../components/Card';
import { NEEDS } from '../../../components/needs';
import { StatusChip } from '../../../components/StatusChip';
import { cn } from '../../../lib/cn';
import { useServiceRequests } from '../../../api/service-requests';
import type { ServiceRequestListItem } from '../../../api/types';
import { listChipForStatus } from '../request-card';

const SHOWN = 3;

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function subLine(item: ServiceRequestListItem): string {
  return item.closed_at
    ? `Closed ${shortDate(item.closed_at)}`
    : `Sent ${shortDate(item.created_at)}`;
}

function Row({ item }: { item: ServiceRequestListItem }) {
  const need = NEEDS[item.category];
  const chip = listChipForStatus(item.status);
  const Icon = need.Icon;
  return (
    <li className="border-t border-line">
      <Link
        to={paths.requestDetail(item.service_request_id)}
        className="flex min-h-18 flex-wrap items-center gap-x-3.5 gap-y-2 py-3.5 text-ink no-underline hover:text-ink"
      >
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-10 text-white',
            need.fill,
          )}
        >
          <Icon />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-bold break-words">{item.summary ?? need.label}</span>
          <span className="text-16 text-slate">{subLine(item)}</span>
        </span>
        <StatusChip kind={chip.kind}>{chip.label}</StatusChip>
      </Link>
    </li>
  );
}

/** "Your requests": the newest few, each a link to its status page. */
export function YourRequests() {
  const requests = useServiceRequests('requested', { limit: 10 });
  const items = requests.data?.service_requests.slice(0, SHOWN) ?? [];
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
            <Row key={item.service_request_id} item={item} />
          ))}
        </ul>
      )}
    </Card>
  );
}
