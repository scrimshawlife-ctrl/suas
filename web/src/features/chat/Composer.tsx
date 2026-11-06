import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { SendIcon } from '../../components/icons';
import { TextArea } from '../../components/TextArea';

export const MAX_MESSAGE_LENGTH = 2000;
/** The character count appears only when the limit is near. */
const COUNT_FROM = 1800;

export interface ComposerProps {
  name: string;
  onSend: (body: string) => void;
}

/** Message box and Send. The label is for assistive tech only; the box is the board's. */
export function Composer({ name, onSend }: ComposerProps) {
  const [text, setText] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const body = text.trim();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (body === '') return;
    onSend(body);
    setText('');
    form.current?.querySelector('textarea')?.focus();
  };

  return (
    <form
      ref={form}
      aria-label="Send a message"
      onSubmit={submit}
      className="flex items-end gap-2.5 border-t border-line px-5 py-4 max-sm:px-4"
    >
      <div className="min-w-0 flex-1 [&_label]:sr-only">
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
      </div>
      <Button type="submit" icon={<SendIcon />} disabled={body === ''}>
        Send
      </Button>
    </form>
  );
}
