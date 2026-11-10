import { Link } from 'react-router';
import type { ChatThread } from '../../api/types';
import { Button } from '../../components/Button';
import { cn } from '../../lib/cn';
import { counterpartName, EMPTY_THREADS, threadTitle } from './copy';
import { isReadOnly, threadHref, threadKey } from './threads';

export interface ThreadListProps {
  threads: ChatThread[] | undefined;
  /** `threadKey` of the open thread. */
  selectedKey: string | undefined;
  isError: boolean;
  onRetry: () => void;
  className?: string;
}

/** The 340 px conversation list: name, request title (", closed" when over), last message. */
export function ThreadList({ threads, selectedKey, isError, onRetry, className }: ThreadListProps) {
  return (
    <nav
      aria-label="Conversations"
      className={cn('flex flex-col overflow-y-auto border-r border-line', className)}
    >
      {threads === undefined ? (
        isError ? (
          <div className="flex flex-col items-start gap-3 p-5">
            <p>We couldn&apos;t load your conversations.</p>
            <Button variant="secondary" size="small" onClick={onRetry}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="p-5 text-slate">
            Loading conversations
          </p>
        )
      ) : threads.length === 0 ? (
        <p className="p-5 text-slate">{EMPTY_THREADS}</p>
      ) : (
        threads.map((thread) => {
          const name = counterpartName(thread);
          const selected = threadKey(thread) === selectedKey;
          return (
            <Link
              key={threadKey(thread)}
              to={threadHref(thread)}
              aria-current={selected ? 'page' : undefined}
              className={cn(
                'flex gap-3 border-b border-line px-5 py-4.5 text-ink no-underline hover:bg-mist hover:text-ink',
                selected && 'bg-mist',
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-11 shrink-0 place-items-center rounded-full text-17 font-bold text-white',
                  thread.closed || isReadOnly(thread) ? 'bg-slate' : 'bg-harbor',
                )}
              >
                {name.charAt(0).toUpperCase()}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-bold">{name}</span>
                <span className="text-16 text-slate">
                  {threadTitle(thread)}
                  {thread.closed || isReadOnly(thread) ? ', closed' : ''}
                </span>
                {thread.last_message_body !== null ? (
                  <span className="truncate text-16 text-slate">{thread.last_message_body}</span>
                ) : null}
              </span>
            </Link>
          );
        })
      )}
    </nav>
  );
}
