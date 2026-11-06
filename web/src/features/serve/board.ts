import { hasApiCode, isApiError } from '../../api/errors';
import type { County, ServiceCategory, ServiceRequestListItem } from '../../api/types';
import { NEEDS } from '../../components/needs';

/** Plain-word helpers for the Serve board. Kept free of React so they are easy to test. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "12 minutes ago", "1 hour ago", "3 days ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (elapsed < MINUTE) return 'just now';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (elapsed < HOUR) return unit(Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return unit(Math.floor(elapsed / HOUR), 'hour');
  return unit(Math.floor(elapsed / DAY), 'day');
}

/** SANTA_CLARA -> "Santa Clara". */
export function countyName(county: County): string {
  return county
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** "Marcus T." -> "Marcus". Falls back to `fallback` when there is no name. */
export function firstName(displayName: string | null | undefined, fallback = ''): string {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : fallback;
}

/** The request's one-line summary, or its category name when the requester wrote none. */
export function summaryOrCategory(summary: string | null, category: ServiceCategory): string {
  const text = summary?.trim();
  return text ? text : NEEDS[category].label;
}

export interface OpenRequestCardModel {
  id: string;
  category: ServiceCategory;
  title: string;
  meta: string;
  /** True when this viewer is in a bordering county of a widened request ("Nearby county"). */
  widened: boolean;
}

/**
 * One open-request row: "{summary}" over "{Category}, opened {time}".
 *
 * `item.widened` is a fact about the request, so it is true for everyone who can see it.
 * The "Nearby county" mark is about the viewer: only a helper outside the requester's
 * county gets it. With no known viewer county nothing is marked.
 */
export function toOpenCard(
  item: ServiceRequestListItem,
  now: number = Date.now(),
  viewerCounty?: County | null,
): OpenRequestCardModel {
  return {
    id: item.service_request_id,
    category: item.category,
    title: summaryOrCategory(item.summary, item.category),
    meta: `${NEEDS[item.category].label}, opened ${relativeTime(item.created_at, now)}`,
    widened: item.widened === true && !!viewerCounty && item.county !== viewerCounty,
  };
}

/** "Santa Clara County, newest first", with bordering counties named only when shown. */
export function boardSubtitle(county: County | null | undefined, anyWidened: boolean): string {
  const place = county ? `${countyName(county)} County` : 'Your county';
  return anyWidened ? `${place} and bordering counties, newest first` : `${place}, newest first`;
}

/** Statuses after which a request no longer needs its helper (src/coordination/request-transitions.ts). */
const FINISHED: readonly string[] = ['CLOSED', 'CANCELLED', 'EXPIRED', 'UNFULFILLABLE'];

/** "You're helping": the accepter's requests that are not finished. */
export function activeHelping(items: readonly ServiceRequestListItem[]): ServiceRequestListItem[] {
  return items.filter((item) => !FINISHED.includes(item.status));
}

export type AcceptFailure =
  | { kind: 'taken'; message: string }
  | { kind: 'gone'; message: string }
  | { kind: 'county' }
  | { kind: 'other'; message: string };

export const TAKEN_MESSAGE = 'Someone else took this one.';
export const GONE_MESSAGE = 'That request is no longer open.';
export const TRY_AGAIN_MESSAGE = 'That did not go through. Try again.';

/** Maps a failed POST /service-requests/{id}/accept to what the board does next. */
export function classifyAcceptError(error: unknown): AcceptFailure {
  if (hasApiCode(error, 'ALREADY_CLAIMED')) return { kind: 'taken', message: TAKEN_MESSAGE };
  if (hasApiCode(error, 'COUNTY_REQUIRED')) return { kind: 'county' };
  if (isApiError(error) && error.status === 409) return { kind: 'taken', message: TAKEN_MESSAGE };
  if (isApiError(error) && error.status === 404) return { kind: 'gone', message: GONE_MESSAGE };
  return { kind: 'other', message: TRY_AGAIN_MESSAGE };
}
