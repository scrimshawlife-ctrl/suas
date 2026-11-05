import { useParams } from 'react-router';
import { useMe } from '../../api/me';
import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { LoadingScreen } from '../../app/status-screens';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { NEEDS } from '../../components/needs';
import { Page } from '../../components/Page';
import { useRequestDetail } from './api';
import { canCancel, resolveRequestCard } from './request-card';
import { RequestStatusCard } from './RequestStatusCard';

function Fact({ label, children }: { label: string; children: string | null }) {
  if (children === null || children === '') return null;
  return (
    <div className="flex flex-col">
      <dt className="text-16 font-bold text-slate">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

/** /requests/:id: the requester's view of one request (QrfStates board). */
export default function RequestDetailPage() {
  const { id } = useParams();
  const me = useMe();
  const request = useRequestDetail(id);

  if (request.isPending || me.isPending) return <LoadingScreen />;

  if (request.isError || !request.data) {
    const missing = isApiError(request.error) && request.error.status === 404;
    return (
      <Page width="narrow">
        <title>Request · SUAS</title>
        <h1 className="heading text-32">
          {missing ? 'We could not find that request.' : 'We could not load this request.'}
        </h1>
        <p className="text-slate">
          {missing
            ? 'It may belong to someone else, or it may have been removed.'
            : 'Check your connection and try again.'}
        </p>
        <div className="flex gap-3">
          {missing ? null : <Button onClick={() => void request.refetch()}>Try again</Button>}
          <Button variant="secondary" href={paths.home}>
            Back to home
          </Button>
        </div>
      </Page>
    );
  }

  const detail = request.data;
  const activeQrf = me.data?.active_qrf ?? null;
  const input = { requestId: detail.service_request_id, status: detail.status, activeQrf };
  const need = NEEDS[detail.category];
  const NeedIcon = need.Icon;

  return (
    <Page>
      <title>Your request · SUAS</title>
      <BackLink to={paths.home}>Back to home</BackLink>
      <h1 className="heading text-44 max-sm:text-32">Your request</h1>
      <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] items-start gap-6 max-md:grid-cols-1">
        <RequestStatusCard
          variant="detail"
          card={resolveRequestCard(input)}
          requestId={detail.service_request_id}
          status={detail.status}
          counterpartName={detail.counterpart_display_name}
          createdAt={detail.created_at}
          cancellable={canCancel(input)}
        />
        <Card aria-labelledby="what-you-sent" className="flex flex-col gap-4">
          <h2 id="what-you-sent" className="flex items-center gap-3 text-20 font-bold">
            <span className={`grid size-10 place-items-center rounded-10 text-white ${need.fill}`}>
              <NeedIcon />
            </span>
            What you sent
          </h2>
          <dl className="flex flex-col gap-3">
            <Fact label="Kind of help">{need.label}</Fact>
            <Fact label="Summary">{detail.summary}</Fact>
            <Fact label="Timing">{detail.timing}</Fact>
            <Fact label="Where should the helper meet you?">{detail.meeting_place}</Fact>
          </dl>
          <p className="text-16 text-slate">
            Only you and the person who accepts this request see the meeting place.
          </p>
        </Card>
      </div>
    </Page>
  );
}
