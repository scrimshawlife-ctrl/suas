import { useParams } from 'react-router';
import { useChatThreads } from '../../api/chat';
import { useMe } from '../../api/me';
import { Page } from '../../components/Page';
import { cn } from '../../lib/cn';
import { Conversation } from './Conversation';
import { ThreadList } from './ThreadList';
import { useChatRealtime } from './useChatRealtime';

/**
 * Chat for both modes, at /chat (the list) and /chat/:serviceRequestId (one conversation).
 * Two panes from 861 px up; below that, one column at a time with a back link.
 */
export default function ChatPage() {
  const { serviceRequestId } = useParams();
  const me = useMe();
  const threads = useChatThreads();
  useChatRealtime();
  const thread = threads.data?.threads.find((t) => t.service_request_id === serviceRequestId);

  return (
    <Page>
      <title>Chat · SUAS</title>
      <h1 className="heading text-40 max-sm:text-32">Chat</h1>
      <div className="grid h-[680px] max-h-[calc(100dvh-13rem)] min-h-[480px] grid-cols-[340px_minmax(0,1fr)] overflow-hidden rounded-12 border border-line bg-white max-[860px]:h-[calc(100dvh-16rem)] max-[860px]:grid-cols-1">
        <ThreadList
          threads={threads.data?.threads}
          selectedId={serviceRequestId}
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
              key={serviceRequestId}
              serviceRequestId={serviceRequestId}
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
