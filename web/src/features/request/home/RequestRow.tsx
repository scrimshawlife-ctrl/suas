import { Link } from 'react-router';
import { paths } from '../../../app/paths';
import { NEEDS } from '../../../components/needs';
import { StatusChip } from '../../../components/StatusChip';
import { cn } from '../../../lib/cn';
import type { ServiceRequestListItem } from '../../../api/types';
import { listChipForStatus } from '../request-card';

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function subLine(item: ServiceRequestListItem): string {
  return item.closed_at
    ? `Closed ${shortDate(item.closed_at)}`
    : `Sent ${shortDate(item.created_at)}`;
}

/** One of the requester's own requests: a link to its status page. Shared by Home and /requests. */
export function RequestRow({ item }: { item: ServiceRequestListItem }) {
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
        <span className="flex min-w-0 flex-[1_1_9rem] flex-col">
          <span className="font-bold break-words">{item.summary ?? need.label}</span>
          <span className="text-16 text-slate">{subLine(item)}</span>
        </span>
        <StatusChip kind={chip.kind}>{chip.label}</StatusChip>
      </Link>
    </li>
  );
}
