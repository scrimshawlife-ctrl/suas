import { Link, useSearchParams } from 'react-router';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { StatusChip } from '../../components/StatusChip';
import { cn } from '../../lib/cn';
import { useResourceDrafts } from './api';
import type { ResourceDraft } from './draft-form';
import { ExtractForm } from './ExtractForm';
import {
  CATEGORY_LABELS,
  countiesLabel,
  isDraftStatus,
  STATUS_LABELS,
  STATUSES,
  type DraftStatus,
} from './labels';
import { QueryNotice } from './QueryNotice';

const formatDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

export function DraftStatusChip({ status }: { status: DraftStatus }) {
  const kind = status === 'PUBLISHED' ? 'ok' : status === 'REJECTED' ? 'off' : 'wait';
  return <StatusChip kind={kind}>{STATUS_LABELS[status]}</StatusChip>;
}

const EMPTY: Record<DraftStatus, string> = {
  DRAFT: 'Nothing to review. Add a resource from a source above.',
  PUBLISHED: 'Nothing has been published yet.',
  REJECTED: 'No drafts have been discarded.',
};

function DraftTable({ drafts }: { drafts: ResourceDraft[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-16">
        <thead>
          <tr>
            {['Service', 'Category', 'Counties', 'Status', 'Updated'].map((heading) => (
              <th
                key={heading}
                scope="col"
                className="border-b border-line px-4 py-2.5 text-left font-bold whitespace-nowrap text-slate"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {drafts.map((draft) => (
            <tr key={draft.resource_draft_id} className="border-b border-line last:border-b-0">
              <td className="min-w-48 px-4 py-3 font-bold">
                <Link
                  to={paths.adminDraft(draft.resource_draft_id)}
                  className="inline-flex min-h-11 items-center"
                >
                  {draft.service_name}
                </Link>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">{CATEGORY_LABELS[draft.category]}</td>
              <td className="min-w-40 px-4 py-3">{countiesLabel(draft.counties)}</td>
              <td className="px-4 py-3">
                <DraftStatusChip status={draft.status} />
              </td>
              <td className="px-4 py-3 whitespace-nowrap text-slate">
                {formatDate.format(new Date(draft.updated_at))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminDraftsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('status');
  const status: DraftStatus = isDraftStatus(requested) ? requested : 'DRAFT';
  const query = useResourceDrafts(status);
  const pages = query.data?.pages ?? [];
  const drafts = pages.flatMap((page) => page.drafts);
  // Builder state is the same on every page; the first one is enough.
  const builderAvailable = pages[0]?.builder.available ?? true;

  return (
    <>
      <title>Resource drafts · SUAS Admin</title>
      <div className="flex flex-col gap-1">
        <h1 className="heading text-40 max-sm:text-32">Resource drafts</h1>
        <p className="text-slate">
          Check each draft against its source, fix anything wrong, then publish it.
        </p>
      </div>

      {pages[0] !== undefined && !builderAvailable ? (
        <Card as="section" aria-label="Catalog builder status" padding="sm" role="status">
          <p className="font-bold">
            {pages[0].builder.message ?? 'The catalog builder is not available right now.'}
          </p>
        </Card>
      ) : null}

      <ExtractForm builderAvailable={builderAvailable} />

      <section aria-labelledby="drafts-title" className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="drafts-title" className="text-22 font-bold">
            Drafts
          </h2>
          <div role="group" aria-label="Show drafts" className="flex flex-wrap gap-2">
            {STATUSES.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={option === status}
                onClick={() => setParams(option === 'DRAFT' ? {} : { status: option })}
                className={cn(
                  'min-h-11 cursor-pointer rounded-8 border-2 px-4 text-16 font-bold',
                  option === status
                    ? 'border-service-blue bg-service-blue text-white'
                    : 'border-ink bg-white text-ink hover:bg-mist',
                )}
              >
                {STATUS_LABELS[option]}
              </button>
            ))}
          </div>
        </div>

        <Card as="div" padding="none" aria-busy={query.isFetching}>
          {query.isPending ? (
            <p role="status" className="p-4 text-slate">
              Loading…
            </p>
          ) : query.isError ? (
            <div className="p-4">
              <QueryNotice error={query.error} what="drafts" onRetry={() => void query.refetch()} />
            </div>
          ) : drafts.length === 0 ? (
            <p className="p-4 text-slate">{EMPTY[status]}</p>
          ) : (
            <DraftTable drafts={drafts} />
          )}
        </Card>

        {query.hasNextPage ? (
          <div className="flex">
            <Button
              variant="secondary"
              size="small"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Show more'}
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}
