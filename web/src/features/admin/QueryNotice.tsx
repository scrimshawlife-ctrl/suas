import { isApiError } from '../../api/errors';
import { Button } from '../../components/Button';
import { AlertCircleIcon } from '../../components/icons';

/** Plain-words load failure with a retry. Never red, never raw server text. */
export function QueryNotice({
  error,
  what,
  onRetry,
}: {
  error: unknown;
  what: string;
  onRetry: () => void;
}) {
  const denied = isApiError(error) && (error.status === 403 || error.status === 401);
  return (
    <div role="alert" className="flex flex-col items-start gap-3">
      <p className="flex items-start gap-2 font-bold">
        <AlertCircleIcon className="mt-1 shrink-0" />
        {denied ? `You do not have access to ${what}.` : `We could not load ${what}.`}
      </p>
      {denied ? null : (
        <Button variant="secondary" size="small" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
