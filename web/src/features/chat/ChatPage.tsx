import { useParams, useSearchParams } from 'react-router';
import { useChatThreads } from '../../api/chat';
import { useMe } from '../../api/me';
import { Page } from '../../components/Page';
import { cn } from '../../lib/cn';
import { Conversation } from './Conversation';
import { ThreadList } from './ThreadList';
import { allThreads, pickThread, THREAD_PARAM, threadKey } from './threads';
import { useChatRealtime } from './useChatRealtime';

/**
 * Chat for both modes, at /chat (the list) and /chat/:serviceRequestId (one conversation).
 * `?thread=<chat_thread_id>` opens one of a request's earlier (closed) threads; without it the
 * live thread opens. Two panes from 861 px up; below that, one column at a time with a back link.
 */
export default function ChatPage() {
  const { serviceRequestId } = useParams();
  const threadParam = useSearchParams()[0].get(THREAD_PARAM);
  const me = useMe();
  const threads = useChatThreads();
  useChatRealtime();
  const list = allThreads(threads.data);
  const thread = pickThread(list, serviceRequestId, threadParam);

  return (
    <Page>
      <title>Chat · SUAS</title>
      <h1 className="heading text-40 max-sm:text-32">Chat</h1>
      <div className="grid h-[clamp(480px,calc(100dvh-20rem),720px)] grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-12 border border-line bg-white max-[860px]:h-[clamp(360px,calc(100dvh-26rem),720px)] max-[860px]:grid-cols-1">
        <ThreadList
          threads={list}
          more={threads}
          selectedKey={thread === undefined ? undefined : threadKey(thread)}
          isError={threads.isError}
          onRetry={() => void threads.refetch()}
          className={cn(serviceRequestId !== undefined && 'max-[860px]:hidden')}
        />
        <section
          aria-labelledby={serviceRequestId !== undefined ? 'chat-with' : undefined}
          aria-label={serviceRequestId === undefined ? 'Conversation' : undefined}
          className={cn(
            'flex min-h-0 min-w-0 flex-col',
            serviceRequestId === undefined && 'max-[860px]:hidden',
          )}
        >
          {serviceRequestId !== undefined ? (
            <Conversation
              key={`${serviceRequestId}:${threadParam ?? ''}`}
              serviceRequestId={serviceRequestId}
              threadId={threadParam ?? undefined}
              thread={thread}
              meUserId={me.data?.user_id}
            />
          ) : (
            <p className="p-6 text-slate">Choose a conversation to read it.</p>
          )}
        </section>
      </div>
    </Page>
  );
}
