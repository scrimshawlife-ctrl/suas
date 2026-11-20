import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { SendIcon } from '../../components/icons';
import { TextArea } from '../../components/TextArea';
import { ASSIST_THINKING, SUGGEST_LABEL, SUGGESTION_NOTE } from './copy';
import type { ChatAssist } from './useChatAssist';

export const MAX_MESSAGE_LENGTH = 2000;
/** The character count appears only when the limit is near. */
const COUNT_FROM = 1800;

export interface ComposerProps {
  name: string;
  onSend: (body: string) => void;
  /** Present for a helper with assistance on (R18.1, contributor proposal, not released). */
  assist?: ChatAssist | undefined;
}

/** Message box and Send. The label is for assistive tech only; the box is the board's. */
export function Composer({ name, onSend, assist }: ComposerProps) {
  const [text, setText] = useState('');
  const [suggested, setSuggested] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const body = text.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (body === '') return;
    onSend(body);
    setText('');
    setSuggested(false);
    form.current?.querySelector('textarea')?.focus();
  };

  // A suggestion only fills the box: into an empty one, or on a new line after what is there.
  const insert = (suggestion: string) => {
    setText((current) =>
      (current === '' ? suggestion : `${current}\n${suggestion}`).slice(0, MAX_MESSAGE_LENGTH),
    );
    setSuggested(true);
  };
  const assistStatus =
    assist?.pending === 'SUGGEST_REPLY'
      ? ASSIST_THINKING
      : assist?.failure?.kind === 'SUGGEST_REPLY'
        ? assist.failure.text
        : null;

  return (
    <form
      ref={form}
      aria-label="Send a message"
      onSubmit={submit}
      className="flex items-end gap-2.5 border-t border-line px-5 py-4 max-sm:flex-wrap max-sm:px-4"
    >
      <div className="min-w-0 flex-1 max-sm:basis-full [&_label]:sr-only">
        <TextArea
          label={`Message ${name}`}
          placeholder={`Message ${name}`}
          rows={1}
          maxLength={MAX_MESSAGE_LENGTH}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          className="max-h-40 text-18"
          helper={
            text.length >= COUNT_FROM
              ? `${String(text.length)} of ${String(MAX_MESSAGE_LENGTH)} characters`
              : undefined
          }
        />
        {suggested ? <p className="mt-1.5 text-16 text-slate">{SUGGESTION_NOTE}</p> : null}
        {assist !== undefined ? (
          <p role="status" aria-live="polite" className="mt-1.5 text-16 empty:hidden">
            {assistStatus}
          </p>
        ) : null}
      </div>
      {assist !== undefined ? (
        <Button
          variant="secondary"
          disabled={assist.pending !== null}
          onClick={() => {
            assist.suggest(insert);
          }}
        >
          {assist.pending === 'SUGGEST_REPLY' ? ASSIST_THINKING : SUGGEST_LABEL}
        </Button>
      ) : null}
      <Button type="submit" icon={<SendIcon />} disabled={body === ''}>
        Send
      </Button>
    </form>
  );
}
