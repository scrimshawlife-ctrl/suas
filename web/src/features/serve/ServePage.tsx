import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router';
import { useMe } from '../../api/me';
import { hasApiCode } from '../../api/errors';
import { queryKeys } from '../../api/keys';
import { useInfiniteServiceRequests, useServiceRequest } from '../../api/service-requests';
import type { ServiceRequestListItem } from '../../api/types';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { AlertCircleIcon, ChatIcon } from '../../components/icons';
import { NEEDS } from '../../components/needs';
import { Page } from '../../components/Page';
import { ShowMoreButton } from '../../components/ShowMoreButton';
import { useSingleFlight } from '../../lib/single-flight';
import { useAcceptRequest, useAlerts, useOpenRequests } from './api';
import { alertSubjectPath, alertText, type Notification } from './alerts';
import {
  activeHelping,
  helpingNowCount,
  boardSubtitle,
  classifyAcceptError,
  firstName,
  relativeTime,
  summaryOrCategory,
  toOpenCard,
} from './board';
import { OpenRequestCard } from './OpenRequestCard';
import { useNow } from './useNow';
import { uniqueBy } from '../../lib/unique-by';

export default function ServePage() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const now = useNow();
  const open = useOpenRequests();
  const accept = useAcceptRequest();
  const flight = useSingleFlight();
  const [notice, setNotice] = useState<string | null>(null);
  // Cards taken or gone before the next refetch lands are hidden at once.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const cards = useMemo(() => {
    const items = uniqueBy(
      open.data?.pages.flatMap((page) => page.service_requests) ?? [],
      (item) => item.service_request_id,
    );
    return items
      .filter((item) => !hidden.has(item.service_request_id))
      .map((item) => toOpenCard(item, now, me.data?.county));
  }, [open.data, hidden, now, me.data?.county]);

  if (hasApiCode(open.error, 'COUNTY_REQUIRED')) return <Navigate to={paths.welcome} replace />;

  const take = (id: string) =>
    flight(() => {
      setNotice(null);
      return accept.mutateAsync(id, {
        onSuccess: () => void navigate(paths.case(id)),
        onError: (error) => {
          const failure = classifyAcceptError(error);
          if (failure.kind === 'county') {
            void navigate(paths.welcome, { replace: true });
            return;
          }
          setNotice(failure.message);
          if (failure.kind !== 'other') setHidden((current) => new Set(current).add(id));
          void queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all });
        },
      });
    });

  const name = firstName(me.data?.display_name);
  const anyWidened = cards.some((card) => card.widened);

  return (
    <Page>
      <title>Serve · SUAS</title>
      <h1 className="heading text-44 max-sm:text-32">
        {name ? `Ready to serve, ${name}.` : 'Ready to serve.'}
      </h1>

      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <section aria-labelledby="open" className="flex flex-col gap-3.5">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="open" className="heading text-28">
              Open requests
            </h2>
            <p className="text-16 text-slate">{boardSubtitle(me.data?.county, anyWidened)}</p>
          </div>

          <p role="status" className="flex items-center gap-2.5 font-bold empty:sr-only">
            {notice ? (
              <>
                <AlertCircleIcon />
                {notice}
              </>
            ) : null}
          </p>

          <OpenList
            state={{
              pending: open.isPending,
              failed: open.isError,
              onRetry: () => void open.refetch(),
            }}
            cards={cards}
            takingId={accept.isPending ? accept.variables : undefined}
            onTake={take}
          />

          <p className="text-16 text-slate">
            You see the full details and meeting place after you take a request.
          </p>
          {open.hasNextPage ? (
            <Button
              variant="secondary"
              className="self-start"
              disabled={open.isFetchingNextPage}
              onClick={() => void open.fetchNextPage()}
            >
              {open.isFetchingNextPage ? 'Loading…' : 'Show more requests'}
            </Button>
          ) : null}
        </section>

        <aside className="flex flex-col gap-4 md:pt-12.5">
          <SummaryCard />
          <HelpingCard />
          <AlertsCard now={now} />
        </aside>
      </div>
    </Page>
  );
}

function OpenList({
  state,
  cards,
  takingId,
  onTake,
}: {
  state: { pending: boolean; failed: boolean; onRetry: () => void };
  cards: ReturnType<typeof toOpenCard>[];
  takingId: string | undefined;
  onTake: (id: string) => void;
}) {
  if (state.pending) return <p className="text-slate">Loading open requests…</p>;
  if (state.failed && cards.length === 0) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <p className="font-bold">We couldn't load the open requests.</p>
        <Button variant="secondary" onClick={state.onRetry}>
          Try again
        </Button>
      </Card>
    );
  }
  if (cards.length === 0) {
    return (
      <Card>
        <p className="font-bold">No open requests right now.</p>
        <p className="text-slate">New requests show up here. This list refreshes on its own.</p>
      </Card>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {cards.map((card) => (
        <OpenRequestCard
          key={card.id}
          card={card}
          taking={takingId === card.id}
          disabled={takingId !== undefined}
          onTake={onTake}
        />
      ))}
    </ul>
  );
}

/** The `ownership=mine` list, paged; the Summary and Helping cards share one query. */
function useMine() {
  const mine = useInfiniteServiceRequests('mine');
  const pages = mine.data?.pages ?? [];
  const list = mine.isSuccess
    ? {
        service_requests: uniqueBy(
          pages.flatMap((page) => page.service_requests),
          (item) => item.service_request_id,
        ),
        next_cursor: pages.at(-1)?.next_cursor ?? null,
        counts: pages[0]?.counts,
      }
    : undefined;
  return { mine, list };
}

function HelpingCard() {
  const { mine, list } = useMine();
  const items = activeHelping(list?.service_requests ?? []);
  return (
    <Card aria-labelledby="helping" emphasis padding="md" className="flex flex-col gap-3.5">
      <h2 id="helping" className="text-20 font-bold">
        You're helping
      </h2>
      {mine.isPending ? <p className="text-slate">Loading…</p> : null}
      {mine.isError ? <p className="text-slate">We couldn't load this list.</p> : null}
      {mine.isSuccess && items.length === 0 ? (
        <p className="text-slate">You're not helping anyone right now. Take a request to start.</p>
      ) : null}
      <ul className="flex flex-col gap-5">
        {items.map((item) => (
          <HelpingRow key={item.service_request_id} item={item} />
        ))}
      </ul>
      <ShowMoreButton list={mine} />
    </Card>
  );
}

/** "Your summary": server counts when present, else the client's own held-request count. */
function SummaryCard() {
  const { mine, list } = useMine();
  const counts = list?.counts;
  // Without server counts, fall back to the client count, which is a dash while the list has
  // more pages, so the board never shows a short number.
  const helping = list === undefined ? undefined : (counts?.helping_now ?? helpingNowCount(list));
  const closed = counts?.closed_last_30_days;
  return (
    <Card aria-labelledby="summary" padding="none" className="flex flex-col">
      <h2 id="summary" className="px-6 pt-5.5 text-18 font-bold">
        Your summary
      </h2>
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
        <div className="flex flex-col-reverse px-6 pt-2 pb-5">
          <dt className="text-16 text-slate">You're helping now</dt>
          <dd className="heading text-44">{helping ?? '–'}</dd>
        </div>
        {closed !== undefined || !mine.isSuccess ? (
          <div className="flex flex-col-reverse border-l border-line px-6 pt-2 pb-5">
            <dt className="text-16 text-slate">Closed in the last 30 days</dt>
            <dd className="heading text-44">{closed ?? '–'}</dd>
          </div>
        ) : null}
      </dl>
    </Card>
  );
}

/** One held request. The timing comes from its detail; the list never carries it. */
function HelpingRow({ item }: { item: ServiceRequestListItem }) {
  const detail = useServiceRequest(item.service_request_id);
  const need = NEEDS[item.category];
  const subLine = [item.counterpart_display_name, detail.data?.timing]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(', ');
  return (
    <li className="flex flex-col gap-3.5">
      <div className="flex items-center gap-3.5">
        <span
          aria-hidden="true"
          className={`grid size-12 shrink-0 place-items-center rounded-10 text-white ${need.fill}`}
        >
          <need.Icon />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="font-bold [overflow-wrap:anywhere]">
            {summaryOrCategory(item.summary, item.category)}
          </span>
          {subLine ? <span className="text-16 text-slate">{subLine}</span> : null}
        </span>
      </div>
      <div className="flex flex-wrap gap-2.5">
        <Button href={paths.case(item.service_request_id)}>Open case</Button>
        <Button
          variant="secondary"
          icon={<ChatIcon />}
          href={paths.chatThread(item.service_request_id)}
        >
          Chat
        </Button>
      </div>
    </li>
  );
}

/** An alert line; a link only when its subject maps to a route. */
function AlertLine({ alert }: { alert: Notification }) {
  const to = alertSubjectPath(alert);
  const text = alertText(alert.reason);
  return to === null ? (
    <span className="font-bold">{text}</span>
  ) : (
    <Link to={to} className="font-bold">
      {text}
    </Link>
  );
}

function AlertsCard({ now }: { now: number }) {
  const alerts = useAlerts();
  const rows = alerts.data ?? [];
  return (
    <Card aria-labelledby="alerts" padding="md" className="pb-2.5">
      <h2 id="alerts" className="mb-1.5 text-20 font-bold">
        Alerts
      </h2>
      {alerts.isPending ? <p className="py-3 text-slate">Loading…</p> : null}
      {alerts.isError ? <p className="py-3 text-slate">We couldn't load alerts.</p> : null}
      {alerts.isSuccess && rows.length === 0 ? (
        <p className="py-3 text-slate">No alerts right now.</p>
      ) : null}
      <ul>
        {rows.map((alert) => (
          <li key={alert.notification_id} className="flex flex-col border-t border-line py-3.5">
            <AlertLine alert={alert} />
            {alert.sent_at ? (
              <span className="text-16 text-slate">{relativeTime(alert.sent_at, now)}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <Link to={paths.notifications} className="inline-flex min-h-11 items-center font-bold">
        See all alerts
      </Link>
    </Card>
  );
}
