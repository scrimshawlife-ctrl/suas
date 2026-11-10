import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import type { ChatThread } from '../../api/types';
import { paths } from '../../app/paths';
import { BackLink } from '../../components/BackLink';
import { Button } from '../../components/Button';
import { useChatMessages } from './api';
import { Composer } from './Composer';
import {
  CHECKING_LINE,
  CLOSED_LINE,
  conversationErrorText,
  counterpartName,
  isPermanentConversationError,
  systemLine,
  threadTitle,
} from './copy';
import { isMine, toOldestFirst } from './messages';
import { MessageList } from './MessageList';
import { useOutbox } from './outbox';
import { isReadOnly, threadKey } from './threads';
import { seenStore } from './unread';

const NOTE_CLASS = 'border-t border-line px-5 py-4 text-slate max-sm:px-4';

export interface ConversationProps {
  serviceRequestId: string;
  /** A named earlier thread to read; absent means the live thread. */
  threadId?: string | undefined;
  thread: ChatThread | undefined;
  meUserId: string | undefined;
}

/** Header, message column and composer for one request's chat. */
export function Conversation({ serviceRequestId, threadId, thread, meUserId }: ConversationProps) {
  const messagesQuery = useChatMessages(serviceRequestId, threadId);
  const outbox = useOutbox(serviceRequestId);
  const name = counterpartName(thread);
  const messages = toOldestFirst(messagesQuery.data);
  const newest = messages[messages.length - 1];

  const seenKey = thread === undefined ? serviceRequestId : threadKey(thread);
  // The conversation is on screen, so everything up to its newest message counts as read.
  const newestAt = newest?.created_at;
  useEffect(() => {
    if (newestAt !== undefined) seenStore.markSeen(seenKey, Date.parse(newestAt));
  }, [seenKey, newestAt]);

  // Screen readers hear a new incoming message; the first load and our own sends stay quiet.
  const live = useRef<HTMLParagraphElement>(null);
  const lastSeenId = useRef<string | undefined>(undefined);
  const newestId = newest?.chat_message_id;
  const newestIsMine = newest !== undefined && isMine(newest, meUserId);
  useEffect(() => {
    if (newestId === undefined) return;
    const previous = lastSeenId.current;
    lastSeenId.current = newestId;
    if (live.current !== null) {
      live.current.textContent =
        previous !== undefined && previous !== newestId && !newestIsMine
          ? `New message from ${name.replace(/\.$/, '')}.`
          : '';
    }
  }, [newestId, newestIsMine, name]);

  // The thread says which side the person is on: requesters see /requests/:id, accepters the case.
  const requestHref =
    thread === undefined
      ? undefined
      : thread.role === 'REQUESTER'
        ? paths.requestDetail(serviceRequestId)
        : paths.case(serviceRequestId);

  return (
    <>
      <div className="px-5 pt-1 min-[861px]:hidden max-sm:px-4">
        <BackLink to={paths.chat}>All conversations</BackLink>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 max-sm:px-4">
        <div className="flex min-w-0 flex-col">
          <h2 id="chat-with" data-route-focus className="text-20 font-bold">
            {name}
          </h2>
          {thread !== undefined ? (
            requestHref !== undefined ? (
              <Link
                to={requestHref}
                className="-my-2.5 inline-flex min-h-11 items-center self-start text-16 font-bold"
              >
                {threadTitle(thread)}
              </Link>
            ) : (
              <span className="text-16 text-slate">{threadTitle(thread)}</span>
            )
          ) : null}
        </div>
      </div>

      {messagesQuery.data === undefined && !messagesQuery.isError ? (
        <p role="status" className="p-6 text-slate">
          Loading messages
        </p>
      ) : messagesQuery.data === undefined ? (
        <div className="flex flex-col items-start gap-3 p-6">
          <p role="alert">{conversationErrorText(messagesQuery.error)}</p>
          {isPermanentConversationError(messagesQuery.error) ? null : (
            <Button variant="secondary" size="small" onClick={() => void messagesQuery.refetch()}>
              Try again
            </Button>
          )}
        </div>
      ) : (
        <>
          <MessageList
            messages={messages}
            pending={outbox.pending}
            meUserId={meUserId}
            counterpart={name}
            openingLine={systemLine(thread)}
            hasEarlier={messagesQuery.hasNextPage}
            loadingEarlier={messagesQuery.isFetchingNextPage}
            earlierFailed={messagesQuery.isFetchNextPageError}
            onLoadEarlier={async () => !(await messagesQuery.fetchNextPage()).isError}
            onRetry={outbox.retry}
          />
          <p ref={live} role="status" className="sr-only" />
          {/* A post always goes to the live thread, so a named thread gets no composer until the
              list has shown it is live. */}
          {isReadOnly(thread) ? (
            <p className={NOTE_CLASS}>{CLOSED_LINE}</p>
          ) : threadId !== undefined && thread === undefined ? (
            <p role="status" className={NOTE_CLASS}>
              {CHECKING_LINE}
            </p>
          ) : (
            <Composer name={name} onSend={outbox.send} />
          )}
        </>
      )}
    </>
  );
}
