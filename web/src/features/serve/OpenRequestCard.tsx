import { Button } from '../../components/Button';
import { StatusChip } from '../../components/StatusChip';
import { NEEDS } from '../../components/needs';
import type { OpenRequestCardModel } from './board';

export interface OpenRequestCardProps {
  card: OpenRequestCardModel;
  /** True while this card's accept is in flight. */
  taking: boolean;
  /** True while any accept is in flight, this card's included; every take button waits. */
  disabled: boolean;
  onTake: (id: string) => void;
}

/** One open request: need icon and colour, summary, "{Category}, opened {time}", and the take button. */
export function OpenRequestCard({ card, taking, disabled, onTake }: OpenRequestCardProps) {
  const need = NEEDS[card.category];
  return (
    <li className="rounded-12 border border-line bg-card px-6 py-5.5 max-sm:px-5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4.5 max-sm:grid-cols-1">
        <span
          aria-hidden="true"
          className={`grid size-12 place-items-center rounded-10 text-white ${need.fill}`}
        >
          <need.Icon />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-20 font-bold [overflow-wrap:anywhere]">{card.title}</span>
          <span className="text-16 text-slate">{card.meta}</span>
          {card.widened ? (
            <StatusChip kind="info" marker="none" className="mt-1.5 self-start">
              Nearby county
            </StatusChip>
          ) : null}
        </span>
        <Button
          disabled={disabled}
          aria-busy={taking || undefined}
          onClick={() => onTake(card.id)}
          aria-label={`${taking ? 'Taking this request' : 'Take this request'}: ${card.title}`}
        >
          {taking ? 'Taking it…' : 'Take this request'}
        </Button>
      </div>
    </li>
  );
}
