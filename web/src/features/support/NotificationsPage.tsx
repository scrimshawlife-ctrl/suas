import { useMode } from '../../app/mode-store';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { ShowMoreButton } from '../../components/ShowMoreButton';
import { useNotifications } from './api';
import { formatDate } from './consent-model';
import { ErrorNotice } from './errors';
import { describeReason, describeWhen, newestFirst } from './notification-reasons';

/** Notifications: what SUAS told you, newest first. No board. */
export default function NotificationsPage() {
  const notifications = useNotifications();
  const items = newestFirst(notifications.data?.pages.flatMap((page) => page.notifications) ?? []);
  // Shared by both modes: a helper who came from Serve goes back to the Serve board.
  const home = useMode() === 'serve' ? paths.serve : paths.home;

  return (
    <Page width="narrow">
      <BackLink to={home}>Back to home</BackLink>
      <h1 className="heading text-40 max-sm:text-30">Notifications</h1>

      {notifications.isPending ? (
        <p role="status" className="text-slate">
          Loading notifications…
        </p>
      ) : notifications.isError && notifications.data === undefined ? (
        <ErrorNotice
          error={notifications.error}
          doing="load your notifications"
          onRetry={() => void notifications.refetch()}
        />
      ) : items.length === 0 ? (
        // Every one on the loaded pages may be hidden; older pages can still hold some.
        notifications.hasNextPage ? null : (
          <Card>
            <p className="font-bold">You have no notifications yet.</p>
          </Card>
        )
      ) : (
        <Card as="div" padding="none">
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.notification_id} className="flex flex-col gap-1 p-5">
                <p className="font-bold">{describeReason(item.reason)}</p>
                <p className="text-16 text-slate">{describeWhen(item, formatDate)}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {notifications.data === undefined ? null : <ShowMoreButton list={notifications} />}
    </Page>
  );
}
