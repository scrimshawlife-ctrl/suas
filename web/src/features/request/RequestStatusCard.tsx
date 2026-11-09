import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ServiceCategory, ServiceRequestStatus } from '../../api/types';
import { paths } from '../../app/paths';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ChatIcon, ChevronRightIcon, XIcon } from '../../components/icons';
import { NEEDS } from '../../components/needs';
import { ProgressTrack } from '../../components/ProgressTrack';
import { StatusChip, type ChipMarker } from '../../components/StatusChip';
import { cardCopy, hasProgressTrack, progressSteps } from './card-copy';
import type { RequestCard } from './request-card';
import { CancelRequest, ConfirmDone } from './RequestActions';

export interface RequestStatusCardProps {
  /** `home` is the QrfActive card; `detail` is the QrfStates card on /requests/:id. */
  variant: 'home' | 'detail';
  card: RequestCard;
  requestId: string;
  /** The request's category; any category other than peer support names itself in the title. */
  category?: ServiceCategory | undefined;
  status?: ServiceRequestStatus | undefined;
  /** The display name of the person who accepted, once there is one. */
  counterpartName?: string | null | undefined;
  /** ISO time the request was recorded. */
  createdAt?: string | undefined;
  cancellable: boolean;
}

/** The home card's title: the QRF name for peer support, the category's own label otherwise. */
function homeTitle(category: ServiceCategory | undefined): string {
  return category === undefined || category === 'PEER_SUPPORT'
    ? 'Your QRF request'
    : `Your ${NEEDS[category].label.toLowerCase()} request`;
}

const MARKERS: Partial<Record<RequestCard, ChipMarker>> = {
  RECEIVED: 'ring',
  NOTIFIED: 'dot',
  UNAVAILABLE: 'ring',
};

function recordedTime(iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? undefined
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** 44px minimum tap target (WCAG 2.2). Visible words stay the D-012 sentence. */
const crisisLink = 'inline-flex min-h-11 min-w-11 items-center px-1 font-bold';

const emergencyLinks = (
  <>
    <a href="tel:911" className={crisisLink} aria-label="Call 911">
      call 911
    </a>
    . For a suicide or emotional crisis,{' '}
    <a href="tel:988" className={crisisLink} aria-label="Call 988">
      call
    </a>{' '}
    or{' '}
    <a href="sms:988" className={crisisLink} aria-label="Text 988">
      text 988
    </a>
    .
  </>
);

function Chip({ card, variant }: { card: RequestCard; variant: 'home' | 'detail' }) {
  const { chip } = cardCopy(card, null);
  const marker: ChipMarker | undefined =
    card === 'MATCHING' ? (variant === 'home' ? 'beacon' : 'dot') : MARKERS[card];
  return (
    // role=status: the label is read out when the state changes while the page is open.
    <div role="status">
      <StatusChip kind={chip.kind} {...(marker ? { marker } : {})}>
        {card === 'CANCELLED' ? <XIcon size={16} strokeWidth={2.5} /> : null}
        {chip.label}
      </StatusChip>
    </div>
  );
}

/**
 * One request's status as the QrfStates board draws it. The words come from the card; the
 * card comes from `resolveRequestCard`, so nothing later than recorded is ever shown.
 */
export function RequestStatusCard(props: RequestStatusCardProps) {
  const { variant, card, requestId, category, status, counterpartName, createdAt, cancellable } =
    props;
  const copy = cardCopy(card, counterpartName);
  const home = variant === 'home';
  const accepted = card === 'ACCEPTED';
  const fulfilled = accepted && status === 'FULFILLED';
  const confirmed = accepted && (status === 'CONFIRMED' || status === 'CLOSED');
  const showTrack = home && hasProgressTrack(card);

  let lead: ReactNode = copy.body;
  if (accepted) {
    lead = (
      <>
        <strong className="text-ink">Important:</strong> {copy.body}
      </>
    );
  }

  return (
    <Card
      emphasis={home || accepted}
      padding={home ? 'xl' : 'lg'}
      aria-labelledby={`status-${requestId}`}
      className={`flex flex-col gap-5.5 ${accepted && !home ? 'border-service-blue' : ''}`}
    >
      {home ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`status-${requestId}`} className="text-18 font-bold">
            {homeTitle(category)}
          </h2>
          <Chip card={card} variant={variant} />
        </div>
      ) : (
        <Chip card={card} variant={variant} />
      )}

      <div className="flex flex-col gap-2.5">
        {home ? (
          <p className="heading text-40 max-sm:text-30">{copy.headline}</p>
        ) : (
          <h2 id={`status-${requestId}`} className="heading text-32 max-sm:text-26">
            {copy.headline}
          </h2>
        )}
        <p className={home ? 'text-19 text-slate' : 'text-slate'}>{lead}</p>
        {fulfilled ? (
          <p className="font-bold">
            {counterpartName
              ? `${counterpartName} marked this request as done.`
              : 'It was marked as done.'}{' '}
            If your need was met, confirm it here.
          </p>
        ) : null}
        {confirmed ? <p className="font-bold">You confirmed this request is done.</p> : null}
      </div>

      {showTrack ? (
        <ProgressTrack
          label="Request progress"
          steps={progressSteps(card, recordedTime(createdAt))}
        />
      ) : null}

      {card === 'UNAVAILABLE' ? (
        <>
          <p>If the situation has become dangerous or life-threatening, {emergencyLinks}</p>
          <ul className="flex flex-col gap-1.5 text-16">
            <li className="flex items-center gap-2">
              <ChevronRightIcon />
              <Link to={paths.home}>Try another support category</Link>
            </li>
          </ul>
        </>
      ) : null}

      {showTrack ? (
        <p className="rounded-8 bg-mist px-4.5 py-4">
          If your situation becomes an emergency while you are waiting, {emergencyLinks}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {fulfilled ? <ConfirmDone requestId={requestId} /> : null}
        {accepted ? (
          <Button href={paths.chatThread(requestId)} icon={<ChatIcon />}>
            Message
          </Button>
        ) : null}
        {card === 'CANCELLED' ? <Button href={paths.request}>Start a new request</Button> : null}
        {cancellable ? <CancelRequest requestId={requestId} /> : null}
        {home ? (
          <Link
            to={paths.requestDetail(requestId)}
            className="inline-flex min-h-11 items-center font-bold"
          >
            See request details
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
