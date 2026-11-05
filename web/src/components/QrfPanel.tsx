import type { ReactNode } from 'react';
import { Button } from './Button';
import { UsersIcon } from './icons';

export interface QrfPanelProps {
  /** Where "Request peer support" goes. */
  href?: string;
  title?: string;
  /** Desktop line. */
  description?: ReactNode;
  /** Phone line (640 px and below). */
  shortDescription?: ReactNode;
  /** Truthfulness line under the button. Always keep it: this is not an emergency request. */
  note?: ReactNode;
}

/**
 * The Peer Support teal QRF panel from the Home board. One per screen. QRF is the fourth
 * need, the one you name.
 */
export function QrfPanel({
  href = '/request?category=PEER_SUPPORT',
  title = 'Talk to someone who served.',
  description = "Veterans in your county get your request. You'll see every real update right here.",
  shortDescription = 'Sends a peer support request to veterans in your county.',
  note = 'This sends a peer support request. It does not contact emergency services.',
}: QrfPanelProps) {
  return (
    <section
      aria-labelledby="qrf-title"
      className="flex flex-col justify-center gap-5.5 rounded-6 bg-need-peer p-11 pb-10 text-white max-sm:gap-4 max-sm:px-5.5 max-sm:pt-7.5 max-sm:pb-6"
    >
      <span className="self-start rounded-6 bg-white px-2.5 py-0.5 font-display text-16 font-semibold tracking-[0.08em] text-ink">
        QRF
      </span>
      <h2 id="qrf-title" className="heading max-w-[14ch] text-54 max-sm:text-34">
        {title}
      </h2>
      <p className="max-w-[40ch] text-20 max-sm:hidden">{description}</p>
      <p className="text-17 sm:hidden">{shortDescription}</p>
      <div className="flex max-sm:flex-col">
        <Button variant="peer" href={href} icon={<UsersIcon size={28} />}>
          Request peer support
        </Button>
      </div>
      <p className="text-16 font-bold">{note}</p>
    </section>
  );
}
