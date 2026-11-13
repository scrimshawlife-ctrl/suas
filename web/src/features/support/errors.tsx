import { Navigate } from 'react-router';
import { GATE_CODES, isApiError, isConnectionError } from '../../api/errors';
import { Button } from '../../components/Button';
import { AlertCircleIcon } from '../../components/icons';
import { paths } from '../../app/paths';

/** Where a gate error sends the person, or null when the error is not a gate. */
export function gateTarget(error: unknown): string | null {
  if (!isApiError(error)) return null;
  if (error.code === GATE_CODES.verificationRequired) return paths.verify;
  if (error.code === GATE_CODES.countyRequired) return paths.welcome;
  if (error.code === GATE_CODES.mfaRequired) return paths.adminMfa;
  return null;
}

/**
 * A plain sentence for any failure, by status. Server text is never shown as is; only a
 * dropped connection or a timeout asks the person to check their connection.
 */
export function errorSentence(error: unknown, doing: string): string {
  if (!isApiError(error) || isConnectionError(error)) {
    return `We could not ${doing}. Check your connection and try again.`;
  }
  if (error.status === 429) return `There were too many tries. Wait a moment, then ${doing}.`;
  if (error.status >= 500) return `Something went wrong on our side. Try to ${doing} again.`;
  if (error.status === 404) return `That is no longer available.`;
  if (error.status === 413) return `We could not ${doing}. What you entered is too long.`;
  if (error.status === 400 || error.status === 422) {
    return `We could not ${doing}. Some of what you entered needs another look.`;
  }
  if (error.status === 403) return `We could not ${doing}. You do not have access to that.`;
  if (error.status === 409) {
    return `We could not ${doing}. This changed while you were looking. Reload the page.`;
  }
  return `We could not ${doing}. Try again.`;
}

/**
 * A failed read or write in plain words (ink, icon, never red). A gate error redirects
 * instead of showing text.
 */
export function ErrorNotice({
  error,
  doing,
  onRetry,
}: {
  error: unknown;
  /** Verb phrase that completes "We could not …", for example "load your consents". */
  doing: string;
  onRetry?: () => void;
}) {
  const target = gateTarget(error);
  if (target !== null) return <Navigate to={target} replace />;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-8 border-2 border-ink bg-white px-4 py-3"
    >
      <AlertCircleIcon />
      <p className="flex-1 font-bold">{errorSentence(error, doing)}</p>
      {onRetry ? (
        <Button size="small" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
