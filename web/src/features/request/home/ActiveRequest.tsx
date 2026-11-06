import type { Me } from '../../../api/types';
import { RequestStatusCard } from '../RequestStatusCard';
import { useRequestDetail } from '../api';
import { canCancel, cardFromQrfState, resolveRequestCard, type RequestCard } from '../request-card';

type ActiveQrf = NonNullable<Me['active_qrf']>;

/**
 * The QrfActive card for `me.active_qrf`. The request read adds the time received, the
 * name of the person who accepted and the status; until it arrives, `active_qrf` alone
 * decides the card, and it stays the authority for everything it can see.
 */
export function ActiveRequest({ active }: { active: ActiveQrf }) {
  const detail = useRequestDetail(active.service_request_id).data;
  const card: RequestCard = detail
    ? resolveRequestCard({
        requestId: active.service_request_id,
        status: detail.status,
        activeQrf: active,
      })
    : (cardFromQrfState(active.state) ?? 'MATCHING');
  const cancellable = detail
    ? canCancel({ requestId: active.service_request_id, status: detail.status, activeQrf: active })
    : active.cancellable;
  return (
    <RequestStatusCard
      variant="home"
      card={card}
      requestId={active.service_request_id}
      category={active.category}
      status={detail?.status}
      counterpartName={detail?.counterpart_display_name}
      createdAt={detail?.created_at}
      cancellable={cancellable}
    />
  );
}
