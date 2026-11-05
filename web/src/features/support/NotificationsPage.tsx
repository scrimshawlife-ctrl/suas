import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Card } from '../../components/Card';
import { Page } from '../../components/Page';
import { useNotifications } from './api';
import { formatDate } from './consent-model';
import { ErrorNotice } from './errors';
import { describeReason, newestFirst } from './notification-reasons';

/** Notifications: what SUAS told you, newest first. No board. */
export default function NotificationsPage() {
  const notifications = useNotifications();
  const items = newestFirst(notifications.data ?? []);

  return (
    <Page width="narrow">
      <BackLink to={paths.home}>Back to home</BackLink>
      <h1 className="heading text-40 max-sm:text-30">Notifications</h1>

      {notifications.isPending ? (
        <p role="status" className="text-slate">
          Loading notifications…
        </p>
      ) : notifications.isError ? (
        <ErrorNotice
          error={notifications.error}
          doing="load your notifications"
          onRetry={() => void notifications.refetch()}
        />
      ) : items.length === 0 ? (
        <Card>
          <p className="font-bold">You have no notifications yet.</p>
        </Card>
      ) : (
        <Card as="div" padding="none">
          <ul className="divide-y divide-line">
            {items.map((item) => (
              <li key={item.notification_id} className="flex flex-col gap-1 p-5">
                <p className="font-bold">{describeReason(item.reason)}</p>
                <p className="text-16 text-slate">
                  {item.sent_at ? formatDate(item.sent_at) : 'Not sent yet'}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
}
