import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { AlertCircleIcon } from '../../components/icons';
import { cn } from '../../lib/cn';
import { formatMessageTime, isMine, runEnds, type ChatMessage } from './messages';
import type { PendingMessage } from './outbox';

export interface MessageListProps {
  /** Oldest to newest. */
  messages: ChatMessage[];
  pending: readonly PendingMessage[];
  meUserId: string | undefined;
  counterpart: string;
  /** The pill above the oldest message. */
  openingLine: string;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  /** The last attempt to load older messages failed; what is shown stays. */
  earlierFailed: boolean;
  /** Resolves true when older messages were added. */
  onLoadEarlier: () => Promise<boolean>;
  onRetry: (clientId: string) => void;
}

const bubble =
  'max-w-[62%] max-[860px]:max-w-[85%] rounded-14 px-4 py-3 leading-[1.45] break-words whitespace-pre-wrap';

/**
 * The scrolling message column. It stays pinned to the newest message while the person is
 * at the bottom, and keeps its place when older messages are prepended.
 */
export function MessageList({
  messages,
  pending,
  meUserId,
  counterpart,
  openingLine,
  hasEarlier,
  loadingEarlier,
  earlierFailed,
  onLoadEarlier,
  onRetry,
}: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Distance from the bottom to restore after older messages are added above. */
  const restore = useRef<number | null>(null);
  const ends = runEnds(messages);
  const newestId = messages[messages.length - 1]?.chat_message_id;
  const pendingCount = useRef(0);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    // Sending a message always brings the person back to the bottom.
    if (pending.length > pendingCount.current) pinned.current = true;
    pendingCount.current = pending.length;
    if (restore.current !== null) {
      el.scrollTop = el.scrollHeight - restore.current;
      restore.current = null;
    } else if (pinned.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [newestId, messages.length, pending.length]);

  const loadEarlier = async () => {
    const el = scroller.current;
    if (el !== null) restore.current = el.scrollHeight - el.scrollTop;
    // On success the layout effect consumes `restore` when the new messages render.
    if (!(await onLoadEarlier())) restore.current = null;
  };

  return (
    <div
      ref={scroller}
      role="region"
      aria-label="Message history"
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto bg-mist p-6 max-sm:p-4"
    >
      {hasEarlier ? (
        <div className="mb-3.5 flex flex-col items-center gap-2">
          {earlierFailed && !loadingEarlier ? (
            <p role="alert" className="text-16">
              {"We couldn't load earlier messages."}
            </p>
          ) : null}
          <Button
            variant="secondary"
            size="small"
            disabled={loadingEarlier}
            onClick={() => void loadEarlier()}
          >
            {loadingEarlier ? 'Loading earlier messages' : 'Load earlier messages'}
          </Button>
        </div>
      ) : null}
      <ol aria-label="Messages" className="flex flex-col gap-3.5">
        {hasEarlier ? null : (
          <li className="self-center rounded-pill bg-white px-4 py-1.5 text-center text-16 text-slate">
            {openingLine}
          </li>
        )}
        {messages.map((message) => {
          const mine = isMine(message, meUserId);
          return (
            <MessageItem key={message.chat_message_id} message={message} mine={mine}>
              {ends.has(message.chat_message_id) ? (
                <p className={cn('mt-1.5 text-16 text-slate', mine ? 'text-right' : 'text-left')}>
                  {mine ? 'You' : counterpart},{' '}
                  <time dateTime={message.created_at}>{formatMessageTime(message.created_at)}</time>
                </p>
              ) : null}
            </MessageItem>
          );
        })}
        {pending.map((item) => (
          <li key={item.clientId} className="flex flex-col items-end">
            <p
              className={cn(
                bubble,
                'rounded-br-[4px]',
                item.status === 'sending'
                  ? 'bg-service-blue text-white opacity-80'
                  : 'border-2 border-ink bg-white text-ink',
              )}
            >
              {item.body}
            </p>
            {item.status === 'sending' ? (
              <p className="mt-1.5 text-16 text-slate">Sending</p>
            ) : item.status === 'refused' ? (
              <p
                role="alert"
                className="mt-1.5 flex flex-wrap items-center justify-end gap-2 text-16"
              >
                <AlertCircleIcon size={20} />
                <span className="font-bold">Could not send.</span>
                <span>{item.reason}</span>
              </p>
            ) : (
              <p
                role="alert"
                className="mt-1.5 flex flex-wrap items-center justify-end gap-2 text-16"
              >
                <AlertCircleIcon size={20} />
                <span className="font-bold">Not sent.</span>
                <button
                  type="button"
                  onClick={() => {
                    onRetry(item.clientId);
                  }}
                  className="min-h-11 cursor-pointer font-bold text-service-blue underline"
                >
                  Try again
                </button>
              </p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function MessageItem({
  message,
  mine,
  children,
}: {
  message: ChatMessage;
  mine: boolean;
  children: ReactNode;
}) {
  return (
    <li className={cn('flex flex-col', mine ? 'items-end' : 'items-start')}>
      <p
        className={cn(
          bubble,
          mine
            ? 'rounded-br-[4px] bg-service-blue text-white'
            : 'rounded-bl-[4px] border border-line bg-white',
        )}
      >
        {message.body}
      </p>
      {children}
    </li>
  );
}
