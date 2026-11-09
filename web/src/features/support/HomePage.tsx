import { Link } from 'react-router';
import { useMe } from '../../api/me';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { CrisisPanel } from '../../components/CrisisPanel';
import { ChevronRightIcon } from '../../components/icons';
import { Page } from '../../components/Page';
import { QrfPanel } from '../../components/QrfPanel';
import { LoadingScreen } from '../../app/status-screens';
import { ActiveRequest } from '../request/home/ActiveRequest';
import { FindHelp } from '../request/home/FindHelp';
import { greeting } from '../request/home/greeting';
import { YourRequests } from '../request/home/YourRequests';
import { CheckInCard } from './CheckInCard';

const PRIVACY_LINKS = [
  { to: paths.consents, label: 'Consents' },
  { to: paths.trustedContacts, label: 'Trusted contacts' },
  { to: paths.notifications, label: 'Notifications' },
] as const;

/** Veteran home: the Home and QrfActive boards, with the Phone board's two-column tiles. */
export default function HomePage() {
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) {
    return (
      <Page width="narrow">
        <h1 className="heading text-32">We could not load your home page.</h1>
        <p className="text-slate">Check your connection and try again.</p>
        <div className="flex">
          <Button onClick={() => void me.refetch()}>Try again</Button>
        </div>
      </Page>
    );
  }

  const { display_name, active_qrf, categories } = me.data;
  return (
    <Page className="gap-7">
      <title>Home · SUAS</title>
      <h1 className="heading text-44 max-sm:text-32">{greeting(display_name)}</h1>

      <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] items-stretch gap-6 max-md:grid-cols-1">
        {active_qrf ? <ActiveRequest active={active_qrf} /> : <QrfPanel />}
        <CrisisPanel />
      </div>

      <div className="grid grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)] items-start gap-6 max-md:grid-cols-1">
        <FindHelp categories={categories} compact={active_qrf !== null} />
        <aside className="flex flex-col gap-4 pt-12.5 max-md:pt-0">
          <YourRequests />
          <CheckInCard verified={me.data.id_verification.status === 'VERIFIED'} />
          <Card as="nav" aria-label="Privacy and messages" className="px-6 py-2.5">
            {PRIVACY_LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="flex min-h-12 items-center justify-between border-b border-line font-bold no-underline last:border-b-0"
              >
                {link.label}
                <ChevronRightIcon />
              </Link>
            ))}
          </Card>
        </aside>
      </div>
    </Page>
  );
}
