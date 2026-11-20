import { useState } from 'react';
import { useSingleFlight } from '../../lib/single-flight';
import { useChatAssistRequest, type ChatAssistKind } from './api';
import { assistErrorText } from './copy';

export interface ChatAssist {
  /** The kind in flight, so its button reads "Thinking…". */
  pending: ChatAssistKind | null;
  /** The last request's failure, shown beside the button that asked. */
  failure: { kind: ChatAssistKind; text: string } | null;
  /** The open catch-up summary, private to the helper. */
  summary: string | null;
  /** Crisis language was found: assistance stays off for this conversation. */
  crisis: boolean;
  catchUp: () => void;
  /** Hands a suggestion to `insert`; it never sends anything. */
  suggest: (insert: (text: string) => void) => void;
  closeSummary: () => void;
}

/**
 * Helper-side chat assistance for one conversation (R18.1–R18.3, contributor proposal, not
 * released). One request at a time; a crisis reply turns both actions off.
 */
export function useChatAssist(serviceRequestId: string): ChatAssist {
  const request = useChatAssistRequest(serviceRequestId);
  const flight = useSingleFlight();
  const [summary, setSummary] = useState<string | null>(null);
  const [crisis, setCrisis] = useState(false);

  const run = (kind: ChatAssistKind, onText: (text: string) => void) => {
    flight(async () => {
      const reply = await request.mutateAsync(kind);
      if (reply.outcome === 'CRISIS_SUPPORT') {
        setSummary(null);
        setCrisis(true);
      } else if (reply.text) {
        onText(reply.text);
      }
    });
  };

  const kind = request.variables ?? null;
  return {
    pending: request.isPending ? kind : null,
    failure:
      request.isError && kind !== null ? { kind, text: assistErrorText(request.error) } : null,
    summary,
    crisis,
    catchUp: () => {
      run('CATCH_UP', setSummary);
    },
    suggest: (insert) => {
      run('SUGGEST_REPLY', insert);
    },
    closeSummary: () => {
      setSummary(null);
    },
  };
}
