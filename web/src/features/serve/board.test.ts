import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import type { ServiceRequestListItem } from '../../api/types';
import {
  GONE_MESSAGE,
  TAKEN_MESSAGE,
  activeHelping,
  boardSubtitle,
  classifyAcceptError,
  firstName,
  relativeTime,
  toOpenCard,
} from './board';

const NOW = Date.parse('2026-11-04T12:00:00Z');

function item(overrides: Partial<ServiceRequestListItem> = {}): ServiceRequestListItem {
  return {
    service_request_id: 'r1',
    case_id: 'c1',
    category: 'FOOD',
    status: 'SUBMITTED',
    summary: 'Groceries for two days',
    created_at: '2026-11-04T11:48:00Z',
    county: 'SANTA_CLARA',
    widened: false,
    ...overrides,
  };
}

describe('open request card mapping', () => {
  it('uses the summary as the title and "{Category}, opened {time}" as the line under it', () => {
    expect(toOpenCard(item(), NOW)).toMatchObject({
      title: 'Groceries for two days',
      meta: 'Food, opened 12 minutes ago',
      widened: false,
    });
  });

  it('falls back to the category name when the summary is null or blank', () => {
    expect(toOpenCard(item({ summary: null, category: 'PEER_SUPPORT' }), NOW).title).toBe(
      'Peer support',
    );
    expect(toOpenCard(item({ summary: '   ' }), NOW).title).toBe('Food');
  });

  it('marks widened items and names bordering counties only then', () => {
    expect(toOpenCard(item({ widened: true }), NOW).widened).toBe(true);
    expect(toOpenCard(item({ widened: undefined }), NOW).widened).toBe(false);
    expect(boardSubtitle('SANTA_CLARA', false)).toBe('Santa Clara County, newest first');
    expect(boardSubtitle('SAN_MATEO', true)).toBe(
      'San Mateo County and bordering counties, newest first',
    );
  });
});

describe('plain-word helpers', () => {
  it('formats elapsed time', () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(relativeTime(at(10_000), NOW)).toBe('just now');
    expect(relativeTime(at(60_000), NOW)).toBe('1 minute ago');
    expect(relativeTime(at(3_600_000), NOW)).toBe('1 hour ago');
    expect(relativeTime(at(3 * 86_400_000), NOW)).toBe('3 days ago');
  });

  it('takes the first name from a display name', () => {
    expect(firstName('Marcus T.')).toBe('Marcus');
    expect(firstName(null, 'friend')).toBe('friend');
  });

  it('lists only requests that are not finished', () => {
    const kept = activeHelping([
      item({ service_request_id: 'a', status: 'IN_PROGRESS' }),
      item({ service_request_id: 'b', status: 'CLOSED' }),
      item({ service_request_id: 'c', status: 'CANCELLED' }),
    ]);
    expect(kept.map((r) => r.service_request_id)).toEqual(['a']);
  });
});

describe('accept failures', () => {
  it('reads ALREADY_CLAIMED as "someone else took this one"', () => {
    expect(classifyAcceptError(new ApiError(409, 'ALREADY_CLAIMED', 'x'))).toEqual({
      kind: 'taken',
      message: TAKEN_MESSAGE,
    });
    expect(TAKEN_MESSAGE).toBe('Someone else took this one.');
  });

  it('reads a 404 as gone, and COUNTY_REQUIRED as a trip to /welcome', () => {
    expect(classifyAcceptError(new ApiError(404, 'NOT_FOUND', 'x'))).toEqual({
      kind: 'gone',
      message: GONE_MESSAGE,
    });
    expect(classifyAcceptError(new ApiError(422, 'COUNTY_REQUIRED', 'x'))).toEqual({
      kind: 'county',
    });
  });

  it('keeps the card for any other failure', () => {
    expect(classifyAcceptError(new ApiError(500, 'INTERNAL', 'x')).kind).toBe('other');
    expect(classifyAcceptError(new Error('offline')).kind).toBe('other');
  });
});
