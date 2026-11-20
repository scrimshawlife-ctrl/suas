import { Button } from '../../components/Button';
import { CrisisPanel } from '../../components/CrisisPanel';
import { XIcon } from '../../components/icons';
import {
  ASSIST_CRISIS_LINE,
  ASSIST_THINKING,
  CATCH_UP_LABEL,
  SUMMARY_CLOSE,
  SUMMARY_TITLE,
} from './copy';
import type { ChatAssist } from './useChatAssist';

/** "Catch me up" in the conversation header, with its own polite status line. */
export function CatchUpButton({ assist }: { assist: ChatAssist }) {
  const failed = assist.failure?.kind === 'CATCH_UP' ? assist.failure.text : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="small"
        disabled={assist.pending !== null}
        onClick={assist.catchUp}
      >
        {assist.pending === 'CATCH_UP' ? ASSIST_THINKING : CATCH_UP_LABEL}
      </Button>
      <p role="status" aria-live="polite" className="text-16 empty:hidden">
        {failed}
      </p>
    </div>
  );
}

/**
 * The helper's private summary card, or the released crisis panel when crisis language was
 * found (R18.3, contributor proposal, not released). The panel copy is SAFETY_COPY.md's own.
 */
export function AssistPanel({ assist }: { assist: ChatAssist }) {
  if (assist.crisis) {
    return (
      <div className="flex max-h-[45%] shrink-0 flex-col gap-3 overflow-y-auto border-b border-line px-5 py-4 max-sm:px-4">
        <p className="font-bold">{ASSIST_CRISIS_LINE}</p>
        <CrisisPanel />
      </div>
    );
  }
  if (assist.summary === null) return null;
  return (
    <div
      role="region"
      aria-label={SUMMARY_TITLE}
      className="flex max-h-[45%] shrink-0 flex-col gap-2 overflow-y-auto border-b border-line bg-mist px-5 py-4 max-sm:px-4"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-16 font-bold text-slate">{SUMMARY_TITLE}</h3>
        <Button variant="icon" aria-label={SUMMARY_CLOSE} onClick={assist.closeSummary}>
          <XIcon />
        </Button>
      </div>
      <p className="whitespace-pre-line">{assist.summary}</p>
    </div>
  );
}
