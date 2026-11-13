import { useInfiniteServiceRequests } from '../../api/service-requests';
import { paths } from '../../app/paths';
import { LoadingScreen } from '../../app/status-screens';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { ShowMoreButton } from '../../components/ShowMoreButton';
import { RequestRow } from './home/RequestRow';

/** /requests: every request the caller made, newest first, reached from Home "See all". */
export default function RequestsPage() {
  const requests = useInfiniteServiceRequests('requested');
  if (requests.isPending) return <LoadingScreen />;

  const items = requests.data?.pages.flatMap((page) => page.service_requests) ?? [];
  return (
    <Page>
      <title>Your requests · SUAS</title>
      <BackLink to={paths.home}>Back to home</BackLink>
      <h1 className="heading text-44 max-sm:text-32">Your requests</h1>
      {requests.isError && items.length === 0 ? (
        <div className="flex flex-col gap-4">
          <p className="text-slate">We could not load your requests. Check your connection.</p>
          <div className="flex">
            <Button onClick={() => void requests.refetch()}>Try again</Button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="text-slate">You have not made a request yet.</p>
      ) : (
        <Card aria-labelledby="all-requests" padding="md" className="pt-3 pb-3">
          <h2 id="all-requests" className="sr-only">
            All requests
          </h2>
          <ul>
            {items.map((item) => (
              <RequestRow key={item.service_request_id} item={item} />
            ))}
          </ul>
        </Card>
      )}
      <ShowMoreButton list={requests} />
    </Page>
  );
}
