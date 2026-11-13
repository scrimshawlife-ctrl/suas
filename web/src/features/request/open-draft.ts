import { isApiError } from '../../api/errors';

/**
 * The id of the open Service Request Draft, kept in the tab's sessionStorage so a reload can
 * read the draft back (R12.1, contributor proposal, SUAS-specs #79). Only the id is stored,
 * never the text. Blocked storage degrades to "no resume", as in api/token-store.ts.
 */
const OPEN_DRAFT_KEY = 'suas.intake-draft';

export const openDraft = {
  get(): string | null {
    try {
      return window.sessionStorage.getItem(OPEN_DRAFT_KEY);
    } catch {
      return null;
    }
  },
  set(draftId: string): void {
    try {
      window.sessionStorage.setItem(OPEN_DRAFT_KEY, draftId);
    } catch {
      // Storage blocked: the draft still lives in memory until reload.
    }
  },
  clear(): void {
    try {
      window.sessionStorage.removeItem(OPEN_DRAFT_KEY);
    } catch {
      // Nothing was stored.
    }
  },
};

/** The draft is gone for good: not found, or no longer DRAFT (submitted or discarded). */
export function isDraftGone(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 404 || (error.status === 409 && error.code === 'ILLEGAL_TRANSITION'))
  );
}
