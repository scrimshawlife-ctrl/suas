import { describe, expect, it } from 'vitest';
import {
  MEETING_PLACE_MAX,
  SUMMARY_MAX,
  meetingPlaceRequired,
  toFormBody,
  validateRequestFields,
  type RequestFields,
} from './request-fields';

const base: RequestFields = {
  category: 'FOOD',
  summary: 'Groceries for the week',
  timing: '',
  meetingPlace: '',
};

describe('meeting place per category', () => {
  it('is required for FOOD, TRANSPORTATION and SHELTER only', () => {
    expect(meetingPlaceRequired('FOOD')).toBe(true);
    expect(meetingPlaceRequired('TRANSPORTATION')).toBe(true);
    expect(meetingPlaceRequired('SHELTER')).toBe(true);
    expect(meetingPlaceRequired('PEER_SUPPORT')).toBe(false);
    expect(meetingPlaceRequired('')).toBe(false);
  });

  it.each(['FOOD', 'TRANSPORTATION', 'SHELTER'] as const)(
    'rejects a blank meeting place for %s',
    (category) => {
      const errors = validateRequestFields({ ...base, category, meetingPlace: '   ' });
      expect(errors.meetingPlace).toBeDefined();
    },
  );

  it('accepts a blank meeting place for PEER_SUPPORT and a filled one for FOOD', () => {
    expect(validateRequestFields({ ...base, category: 'PEER_SUPPORT' })).toEqual({});
    expect(validateRequestFields({ ...base, meetingPlace: 'Library steps' })).toEqual({});
  });

  it('enforces the 200 character limit on an optional meeting place too', () => {
    const errors = validateRequestFields({
      ...base,
      category: 'PEER_SUPPORT',
      meetingPlace: 'x'.repeat(MEETING_PLACE_MAX + 1),
    });
    expect(errors.meetingPlace).toBeDefined();
  });
});

describe('other fields', () => {
  it('needs a category and a summary within 280 characters', () => {
    expect(validateRequestFields({ ...base, category: '' }).category).toBeDefined();
    expect(validateRequestFields({ ...base, summary: ' ' }).summary).toBeDefined();
    expect(
      validateRequestFields({ ...base, summary: 'x'.repeat(SUMMARY_MAX + 1), meetingPlace: 'a' })
        .summary,
    ).toBeDefined();
  });

  it('leaves empty optional fields out of the form body', () => {
    expect(toFormBody({ ...base, meetingPlace: ' Library ', timing: '' })).toEqual({
      category: 'FOOD',
      summary: 'Groceries for the week',
      meeting_place: 'Library',
    });
  });
});
