import { Link } from 'react-router';
import { AlertCircleIcon } from '../../components/icons';
import type { IntakeTurn } from './api';

export const FALLBACK_NOTICE =
  'The assistant is not available right now. The simple form below sends the same request.';

/** The assistant could not answer; the page moves to the plain form. */
export function turnNeedsForm(turn: IntakeTurn): boolean {
  return turn.outcome === 'FALLBACK_FORM';
}

/**
 * One assistant turn: its reply, the "not available yet" notice and any listings, each
 * linked to its resource category page. The reply is typed text from the server, shown as
 * plain text and never logged.
 */
export function IntakeTurnView({ turn }: { turn: IntakeTurn }) {
  if (turnNeedsForm(turn)) return <p>{FALLBACK_NOTICE}</p>;
  return (
    <div className="flex flex-col gap-3">
      {turn.assistant_message ? (
        <p className="whitespace-pre-line">{turn.assistant_message}</p>
      ) : null}
      {turn.notice ? (
        <p className="flex items-start gap-2.5 rounded-8 bg-mist px-4 py-3.5 font-bold">
          <AlertCircleIcon className="mt-0.5 shrink-0" />
          {turn.notice}
        </p>
      ) : null}
      {turn.resources.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-16 font-bold text-slate">Listings that may help</p>
          <ul className="flex flex-col gap-1.5">
            {turn.resources.map((resource) => (
              <li key={resource.resource_id} className="flex flex-col">
                <Link
                  to={`/resources/${resource.category.toLowerCase()}`}
                  className="inline-flex min-h-11 items-center font-bold"
                >
                  {resource.service_name}
                </Link>
                {resource.stale_warning ? (
                  <span className="text-16 text-slate">
                    This listing may be out of date. Check before you go.
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
