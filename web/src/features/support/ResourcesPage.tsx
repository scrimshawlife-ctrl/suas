import { useParams } from 'react-router';
import { useMe } from '../../api/me';
import { paths } from '../../app/paths';
import { LoadingScreen } from '../../app/status-screens';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Icon } from '../../components/Icon';
import { MailIcon, PhoneIcon } from '../../components/icons';
import { NEEDS } from '../../components/needs';
import { Page } from '../../components/Page';
import { StatusChip } from '../../components/StatusChip';
import { cn } from '../../lib/cn';
import { useResources, type CatalogResource } from './api';
import { ErrorNotice } from './errors';
import {
  categoryFromParam,
  contactAction,
  countyName,
  describeFreshness,
  REQUEST_BAND,
} from './resources-model';

/** Long addresses wrap inside the button instead of widening the page. */
const WRAP = 'h-auto max-w-full py-2 text-left [overflow-wrap:anywhere]';

function ClockIcon() {
  return (
    <Icon size={16}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}

function ResourceCard({ resource }: { resource: CatalogResource }) {
  const freshness = describeFreshness(resource);
  const contact = contactAction(resource);
  const where =
    resource.counties.length > 0
      ? resource.counties.map(countyName).join(', ')
      : 'Serves any county';
  return (
    <Card as="li" padding="lg" className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h3 className="min-w-0 text-22 leading-tight font-bold break-words">
          {resource.service_name}
        </h3>
        <StatusChip kind={freshness.chip === 'ok' ? 'ok' : 'stale'}>
          {freshness.chip === 'ok' ? null : <ClockIcon />}
          {freshness.label}
        </StatusChip>
      </div>
      <p className="text-slate">{where}</p>
      {freshness.outOfDate ? <p className="font-bold">This listing may be out of date.</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-17">
        <dt className="text-slate">Hours</dt>
        <dd>{resource.hours ?? 'Not recorded'}</dd>
        <dt className="text-slate">Cost</dt>
        <dd>{resource.cost ?? 'Not recorded'}</dd>
      </dl>
      {contact.kind === 'none' ? (
        <p className="pt-1.5 text-slate">No contact method recorded.</p>
      ) : contact.kind === 'text' ? (
        <p className="pt-1.5 break-words">{contact.text}</p>
      ) : (
        <div className="flex flex-wrap gap-2.5 pt-1.5">
          {contact.kind === 'phone' ? (
            <Button size="small" className={WRAP} icon={<PhoneIcon />} href={contact.href}>
              {contact.label}
            </Button>
          ) : contact.kind === 'email' ? (
            <Button
              size="small"
              variant="secondary"
              className={WRAP}
              icon={<MailIcon />}
              href={contact.href}
            >
              {contact.label}
            </Button>
          ) : (
            <Button
              size="small"
              variant="secondary"
              className={WRAP}
              href={contact.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {contact.label}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function NotAvailable() {
  return (
    <Page>
      <BackLink to={paths.home}>Back to Find help</BackLink>
      <h1 className="heading text-40">Not available yet</h1>
      <p className="max-w-[640px] text-slate">
        We do not have listings for that kind of help yet. You can go back and choose another, or
        ask for help and SUAS will tell you what it can do.
      </p>
      <div className="flex">
        <Button href={paths.request}>Ask for help</Button>
      </div>
    </Page>
  );
}

/** Resources board: title block, request band, then the county's listings. */
export default function ResourcesPage() {
  const { category: param } = useParams();
  const category = categoryFromParam(param);
  const me = useMe();
  const county = me.data?.county ?? null;
  const listings = useResources(category, county);

  if (category === null) return <NotAvailable />;
  if (me.isPending) return <LoadingScreen />;
  if (me.isError)
    return (
      <ErrorNotice error={me.error} doing="load your account" onRetry={() => void me.refetch()} />
    );

  const need = NEEDS[category];
  const NeedIcon = need.Icon;
  const band = REQUEST_BAND[category];
  const resources = listings.data?.pages.flatMap((page) => page.resources) ?? [];

  return (
    <Page>
      <title>{`${need.label} · SUAS`}</title>
      <div className="flex flex-col gap-4.5">
        <div className="flex items-center gap-5">
          <span
            aria-hidden="true"
            className={cn(
              'grid size-16 shrink-0 place-items-center rounded-12 text-white',
              need.fill,
            )}
          >
            <NeedIcon size={34} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="heading text-56 break-words hyphens-auto max-sm:text-40 max-[380px]:text-30">
              {need.label}
            </h1>
            <p className="text-slate">
              Listings for {county ? `${countyName(county)} County` : 'your county'}. Check details
              with the provider before you go.
            </p>
          </div>
        </div>
        <BackLink to={paths.home}>Back to Find help</BackLink>
      </div>

      <section
        aria-labelledby="need"
        className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-5 rounded-12 bg-harbor px-8 py-7 text-white max-[860px]:grid-cols-1 max-sm:px-5"
      >
        <div className="flex flex-col gap-1.5">
          <h2 id="need" className="heading text-30 max-sm:text-24">
            {band.heading}
          </h2>
          <p>{band.body}</p>
          <p className="text-16 text-harbor-tint">
            A submitted request does not guarantee fulfillment.
          </p>
        </div>
        <Button variant="teal" href={`${paths.request}?category=${category}`}>
          {band.button}
        </Button>
      </section>

      <section aria-labelledby="listings" className="flex flex-col gap-4">
        <h2 id="listings" className="heading text-28">
          Local listings
        </h2>
        {listings.isPending ? (
          <p role="status" className="text-slate">
            Loading listings…
          </p>
        ) : resources.length === 0 && listings.isError ? (
          <ErrorNotice
            error={listings.error}
            doing="load the listings"
            onRetry={() => void listings.refetch()}
          />
        ) : resources.length === 0 ? (
          <Card>
            <p className="font-bold">No listings for your county yet.</p>
            <p className="text-slate">
              SUAS has no {need.label.toLowerCase()} listings for your county right now. You can
              still send a request above.
            </p>
          </Card>
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-4.5 max-[860px]:grid-cols-1">
              {resources.map((resource) => (
                <ResourceCard key={resource.resource_id} resource={resource} />
              ))}
            </ul>
            {listings.hasNextPage ? (
              <Button
                variant="secondary"
                className="mt-2 self-center"
                disabled={listings.isFetchingNextPage}
                onClick={() => void listings.fetchNextPage()}
              >
                {listings.isFetchingNextPage ? 'Loading…' : 'Show more listings'}
              </Button>
            ) : null}
            {listings.isError ? (
              <ErrorNotice
                error={listings.error}
                doing="load more listings"
                onRetry={() => void listings.fetchNextPage()}
              />
            ) : null}
          </>
        )}
      </section>
    </Page>
  );
}
