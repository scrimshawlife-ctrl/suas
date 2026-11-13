import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/Button';
import { SendIcon } from '../../components/icons';
import { TextArea } from '../../components/TextArea';
import { useSingleFlight } from '../../lib/single-flight';
import { useOpenDraft, useSendIntakeMessage, type IntakeDraft, type IntakeTurn } from './api';
import { DraftCard } from './DraftCard';
import { useDraftEditor } from './draft-editor';
import { gateRedirect, requestErrorMessage } from './errors';
import { InlineError } from './InlineError';
import { IntakeTurnView, turnNeedsForm } from './IntakeTurnView';
import { INTAKE_TEXT_MAX } from './request-fields';

interface Exchange {
  id: number;
  said: string;
  turn: IntakeTurn;
}

export interface AssistantPanelProps {
  /** The assistant did not answer: the page shows the plain form with what was typed. */
  onFallback: (typed: string) => void;
}

/**
 * The Intake Assistant: type what you need, read the reply, then check and send the draft.
 * What you type stays in this component's memory; it is sent to the API and never logged.
 * After a reload, an open draft comes back with its fields and typed text, not the replies.
 */
export function AssistantPanel({ onFallback }: AssistantPanelProps) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [draft, setDraft] = useState<IntakeDraft | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const send = useSendIntakeMessage();
  const flight = useSingleFlight();
  const editor = useDraftEditor(draft);
  const open = useOpenDraft();
  const [resumedText, setResumedText] = useState<string | null>(null);

  // Resume once, and only into an untouched panel: a message sent meanwhile made a new draft.
  if (open.data && draft === null && resumedText === null && exchanges.length === 0) {
    setDraft(open.data);
    setReady(true);
    setResumedText(open.data.intake_text);
  }

  const onSend = async () => {
    const typed = text.trim();
    if (typed === '') return;
    setFailure(null);
    try {
      // Keep the person's edits: a reply rebuilds the draft from what the server holds.
      // If the edits cannot be saved, stop: a reply would rebuild the draft without them.
      if (draft) await editor.save();
      const turn = await send.mutateAsync({ draftId: draft?.draft_id ?? null, text: typed });
      setExchanges((list) => [...list, { id: list.length, said: typed, turn }]);
      setText('');
      if (turn.draft) setDraft(turn.draft);
      setReady(turn.outcome === 'DRAFT_READY');
      if (turnNeedsForm(turn)) onFallback(typed);
    } catch (error) {
      const gate = gateRedirect(error);
      if (gate) void navigate(gate, { replace: true });
      else setFailure(error);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {resumedText !== null ? (
        <div className="flex flex-col gap-1 border-l-4 border-line pl-4">
          <span className="text-16 font-bold text-slate">You wrote</span>
          <p className="whitespace-pre-line break-words">{resumedText}</p>
        </div>
      ) : null}
      {exchanges.length > 0 ? (
        <ol aria-live="polite" aria-label="Conversation" className="flex flex-col gap-4">
          {exchanges.map((exchange) => (
            <li key={exchange.id} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1 border-l-4 border-line pl-4">
                <span className="text-16 font-bold text-slate">You</span>
                <p className="whitespace-pre-line break-words">{exchange.said}</p>
              </div>
              <div className="flex flex-col gap-1 rounded-12 border border-line bg-card px-4.5 py-3.5">
                <span className="text-16 font-bold text-slate">Assistant</span>
                <IntakeTurnView turn={exchange.turn} />
              </div>
            </li>
          ))}
        </ol>
      ) : null}

      {ready && draft ? <DraftCard draft={draft} editor={editor} /> : null}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          flight(onSend);
        }}
        className="flex flex-col gap-4"
      >
        <TextArea
          label="Tell us what you need"
          helper="Typed text in English, up to 2,000 characters."
          rows={4}
          maxLength={INTAKE_TEXT_MAX}
          value={text}
          disabled={send.isPending}
          onChange={(event) => setText(event.target.value)}
        />
        {failure ? <InlineError>{requestErrorMessage(failure)}</InlineError> : null}
        <div className="flex items-center gap-4">
          <Button
            type="submit"
            size="form"
            icon={<SendIcon />}
            disabled={send.isPending || text.trim() === ''}
          >
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
          {send.isPending ? (
            <p role="status" className="text-slate">
              Reading what you wrote…
            </p>
          ) : null}
        </div>
      </form>
    </div>
  );
}
