import type { ReactNode } from 'react';
import { Navigate, useParams } from 'react-router';
import { hasApiCode } from '../../api/errors';
import { useServiceRequest } from '../../api/service-requests';
import type { ServiceRequestDetail } from '../../api/types';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ChatIcon, MapPinIcon } from '../../components/icons';
import { NEEDS } from '../../components/needs';
import { Page } from '../../components/Page';
import { StatusChip } from '../../components/StatusChip';
import { useCaseServiceRequests, useContactAttempts, useRunStep } from './api';
import { firstName, summaryOrCategory } from './board';
import {
  NOT_FOUND_MESSAGE,
  attemptLabel,
  attemptsOldestFirst,
  commandErrorMessage,
  formatWhen,
  isNotHelperError,
  nextStep,
  statusKind,
  statusLabel,
} from './case-logic';
import { ContactLog } from './ContactLog';

export default function CasePage() {
  const { id } = useParams();
  const request = useServiceRequest(id);
  const caseId = request.data?.case_id;
  const attempts = useContactAttempts(caseId);

  if (hasApiCode(request.error, 'COUNTY_REQUIRED')) return <Navigate to={paths.welcome} replace />;
  // Only the accepter may read the contact log, so a 403 there means this is not their case.
  if (isNotHelperError(request.error) || isNotHelperError(attempts.error)) return <NotFound />;
  if (request.isError || attempts.isError) {
    return (
      <Shell>
        <Card className="flex flex-col items-start gap-3">
          <p className="font-bold">We couldn't load this request.</p>
          <Button
            variant="secondary"
            onClick={() => {
              void request.refetch();
              void attempts.refetch();
            }}
          >
            Try again
          </Button>
        </Card>
      </Shell>
    );
  }
  if (!request.data || !attempts.data) {
    return (
      <Shell>
        <p className="text-slate">Loading the request…</p>
      </Shell>
    );
  }

  return <CaseView request={request.data} attempts={attempts.data} />;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <Page className="gap-6 pt-8">
      <title>Case · SUAS</title>
      <BackLink to={paths.serve}>Back to Serve</BackLink>
      {children}
    </Page>
  );
}

function NotFound() {
  return (
    <Shell>
      <h1 className="heading text-32">{NOT_FOUND_MESSAGE}</h1>
      <p className="text-slate">
        It may have been taken by someone else, or it isn't yours to see.
      </p>
      <Button href={paths.serve} className="self-start">
        Back to Serve
      </Button>
    </Shell>
  );
}

type Attempts = NonNullable<ReturnType<typeof useContactAttempts>['data']>;

function CaseView({ request, attempts }: { request: ServiceRequestDetail; attempts: Attempts }) {
  const need = NEEDS[request.category];
  const requester = firstName(request.counterpart_display_name);
  const title = summaryOrCategory(request.summary, request.category);

  return (
    <Page className="gap-6 pt-8">
      <title>{`${title} · SUAS`}</title>
      <BackLink to={paths.serve}>Back to Serve</BackLink>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <span
              className={`inline-flex min-h-8 items-center rounded-pill px-3.5 py-0.5 text-16 font-bold text-white ${need.fill}`}
            >
              {need.label}
            </span>
            {/* Role-based: this is the accepter's view. History below is the timed fact and is
                omitted when no accept time is recorded (accepted_at null). */}
            <StatusChip kind="ok">You accepted</StatusChip>
          </div>
          <h1 className="heading text-48 [overflow-wrap:anywhere] max-sm:text-32">{title}</h1>
        </div>
        <Button href={paths.chatThread(request.service_request_id)} icon={<ChatIcon />}>
          {requester ? `Open chat with ${requester}` : 'Open chat'}
        </Button>
      </div>

      <div className="grid items-start gap-6 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <WhatsNeeded request={request} />
          <ContactLog caseId={request.case_id} />
        </div>
        <aside className="flex flex-col gap-4">
          <Progress request={request} />
          <History request={request} attempts={attempts} requester={requester} />
          <CaseRequests request={request} />
        </aside>
      </div>
    </Page>
  );
}

function WhatsNeeded({ request }: { request: ServiceRequestDetail }) {
  const rows: { label: string; value: string | null; pin?: boolean }[] = [
    { label: 'Requested by', value: request.counterpart_display_name },
    { label: 'When', value: request.timing },
    { label: 'Where to meet', value: request.meeting_place, pin: true },
    { label: 'Going to', value: request.destination ?? null },
  ];
  return (
    <Card aria-labelledby="details" padding="lg" className="flex flex-col gap-5 max-sm:p-5">
      <h2 id="details" className="text-22 font-bold">
        What's needed
      </h2>
      {request.summary ? (
        <p className="text-20 leading-[1.55] [overflow-wrap:anywhere]">“{request.summary}”</p>
      ) : null}
      <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-5 gap-y-3.5 max-sm:grid-cols-1 max-sm:gap-y-0.5">
        {rows
          .filter((row) => row.value !== null && row.value !== '')
          .map((row) => (
            <div key={row.label} className="contents">
              <dt className="font-bold text-slate">{row.label}</dt>
              <dd className="flex gap-2 [overflow-wrap:anywhere] max-sm:mb-2.5">
                {row.pin ? <MapPinIcon className="mt-0.5" /> : null}
                {row.value}
              </dd>
            </div>
          ))}
      </dl>
    </Card>
  );
}

function Progress({ request }: { request: ServiceRequestDetail }) {
  const step = nextStep(request.status);
  const run = useRunStep(request.service_request_id);
  return (
    <Card aria-labelledby="progress" padding="lg" className="flex flex-col gap-3 max-sm:p-5">
      <h2 id="progress" className="text-20 font-bold">
        Progress
      </h2>
      <p role="status" className="flex items-center gap-2 font-bold">
        <StatusChip kind={statusKind(request.status)}>{statusLabel(request.status)}</StatusChip>
      </p>
      {step ? (
        <Button className="self-start" disabled={run.isPending} onClick={() => run.mutate(step)}>
          {run.isPending ? 'Saving…' : step.label}
        </Button>
      ) : null}
      {request.status === 'FULFILLED' ? (
        <p className="text-slate">
          Waiting for {request.counterpart_display_name ?? 'the person you helped'} to confirm it's
          done.
        </p>
      ) : null}
      {run.isError ? <p className="font-bold">{commandErrorMessage(run.error)}</p> : null}
    </Card>
  );
}

function History({
  request,
  attempts,
  requester,
}: {
  request: ServiceRequestDetail;
  attempts: Attempts;
  requester: string;
}) {
  const events = [
    { key: 'opened', label: 'Request opened', when: request.created_at },
    ...(request.accepted_at
      ? [{ key: 'accepted', label: 'You accepted', when: request.accepted_at }]
      : []),
    ...attemptsOldestFirst(attempts).map((attempt) => ({
      key: attempt.contact_attempt_id,
      label: attemptLabel(attempt, requester),
      when: attempt.attempted_at,
    })),
  ].sort((a, b) => Date.parse(a.when) - Date.parse(b.when));
  return (
    <Card aria-labelledby="history" padding="lg" className="max-sm:p-5">
      <h2 id="history" className="mb-4 text-20 font-bold">
        History
      </h2>
      <ol>
        {events.map((event) => (
          <li
            key={event.key}
            className="relative pb-4.5 pl-7 before:absolute before:top-2.5 before:-bottom-2 before:left-1.5 before:w-0.5 before:bg-line last:pb-0 last:before:hidden"
          >
            <span
              aria-hidden="true"
              className="absolute top-1.5 left-0 size-3.5 rounded-full bg-harbor"
            />
            <span className="block font-bold">{event.label}</span>
            <span className="text-16 text-slate">{formatWhen(event.when)}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function CaseRequests({ request }: { request: ServiceRequestDetail }) {
  const list = useCaseServiceRequests(request.case_id);
  return (
    <Card aria-labelledby="sr" padding="lg" className="flex flex-col gap-3 max-sm:p-5">
      <h2 id="sr" className="text-20 font-bold">
        Service requests
      </h2>
      {list.isPending ? <p className="text-slate">Loading…</p> : null}
      {list.isError ? <p className="text-slate">We couldn't load this list.</p> : null}
      <ul className="flex flex-col gap-3">
        {list.data?.map((item) => (
          <li
            key={item.service_request_id}
            className="flex flex-wrap items-center justify-between gap-2.5"
          >
            <span>{NEEDS[item.category].label}</span>
            <StatusChip kind={statusKind(item.status)}>{statusLabel(item.status)}</StatusChip>
          </li>
        ))}
      </ul>
    </Card>
  );
}
