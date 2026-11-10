import { describe, expect, it } from 'vitest';
import type { ServiceRequestDetail } from '../../api/types';
import {
  DESTINATION_MAX,
  MEETING_PLACE_MAX,
  SUMMARY_MAX,
  destinationAllowed,
  fieldsFromDetail,
  meetingPlaceRequired,
  mergeFields,
  requestEdit,
  toFormBody,
  validateRequestFields,
  type RequestFields,
} from './request-fields';

const base: RequestFields = {
  category: 'FOOD',
  summary: 'Groceries for the week',
  timing: '',
  meetingPlace: '',
  destination: '',
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

describe('destination', () => {
  const ride: RequestFields = { ...base, category: 'TRANSPORTATION', meetingPlace: 'Library' };

  it('belongs to TRANSPORTATION only', () => {
    expect(destinationAllowed('TRANSPORTATION')).toBe(true);
    expect(destinationAllowed('FOOD')).toBe(false);
    expect(destinationAllowed('')).toBe(false);
  });

  it('is bounded to 200 characters for a ride and ignored for other categories', () => {
    const long = 'x'.repeat(DESTINATION_MAX + 1);
    expect(validateRequestFields({ ...ride, destination: long }).destination).toBeDefined();
    expect(validateRequestFields({ ...ride, destination: 'x'.repeat(DESTINATION_MAX) })).toEqual(
      {},
    );
    expect(validateRequestFields({ ...base, destination: long }).destination).toBeUndefined();
  });

  it('goes into the form body for a ride only', () => {
    expect(toFormBody({ ...ride, destination: ' Clinic ' })).toMatchObject({
      destination: 'Clinic',
    });
    expect(toFormBody({ ...base, destination: 'Clinic' })).not.toHaveProperty('destination');
    expect(toFormBody(ride)).not.toHaveProperty('destination');
  });

  it('is dropped when the category moves away from TRANSPORTATION', () => {
    const typed = { ...ride, destination: 'Clinic' };
    expect(mergeFields(typed, { category: 'FOOD' }).destination).toBe('');
    expect(mergeFields(typed, { summary: 'New' }).destination).toBe('Clinic');
  });
});

describe('requestEdit', () => {
  const sent = {
    service_request_id: 'r1',
    case_id: 'c1',
    category: 'TRANSPORTATION',
    status: 'MATCHING',
    summary: 'A ride',
    timing: 'Thursday',
    meeting_place: 'Library',
    destination: 'Clinic',
  } as ServiceRequestDetail;

  it('is empty when nothing changed', () => {
    expect(requestEdit(fieldsFromDetail(sent), sent)).toEqual({});
  });

  it('sends only what changed and null for a cleared optional field', () => {
    const fields = {
      ...fieldsFromDetail(sent),
      summary: ' A ride at 9 ',
      timing: '',
      destination: '',
    };
    expect(requestEdit(fields, sent)).toEqual({
      summary: 'A ride at 9',
      timing: null,
      destination: null,
    });
  });
});

describe('destination', () => {
  const ride: RequestFields = { ...base, category: 'TRANSPORTATION', meetingPlace: 'Library' };

  it('belongs to TRANSPORTATION only', () => {
    expect(destinationAllowed('TRANSPORTATION')).toBe(true);
    expect(destinationAllowed('FOOD')).toBe(false);
    expect(destinationAllowed('')).toBe(false);
  });

  it('is bounded to 200 characters for a ride and ignored for other categories', () => {
    const long = 'x'.repeat(DESTINATION_MAX + 1);
    expect(validateRequestFields({ ...ride, destination: long }).destination).toBeDefined();
    expect(validateRequestFields({ ...ride, destination: 'x'.repeat(DESTINATION_MAX) })).toEqual(
      {},
    );
    expect(validateRequestFields({ ...base, destination: long }).destination).toBeUndefined();
  });

  it('goes into the form body for a ride only', () => {
    expect(toFormBody({ ...ride, destination: ' Clinic ' })).toMatchObject({
      destination: 'Clinic',
    });
    expect(toFormBody({ ...base, destination: 'Clinic' })).not.toHaveProperty('destination');
    expect(toFormBody(ride)).not.toHaveProperty('destination');
  });

  it('is dropped when the category moves away from TRANSPORTATION', () => {
    const typed = { ...ride, destination: 'Clinic' };
    expect(mergeFields(typed, { category: 'FOOD' }).destination).toBe('');
    expect(mergeFields(typed, { summary: 'New' }).destination).toBe('Clinic');
  });
});

describe('requestEdit', () => {
  const sent = {
    service_request_id: 'r1',
    case_id: 'c1',
    category: 'TRANSPORTATION',
    status: 'MATCHING',
    summary: 'A ride',
    timing: 'Thursday',
    meeting_place: 'Library',
    destination: 'Clinic',
  } as ServiceRequestDetail;

  it('is empty when nothing changed', () => {
    expect(requestEdit(fieldsFromDetail(sent), sent)).toEqual({});
  });

  it('sends only what changed and null for a cleared optional field', () => {
    const fields = {
      ...fieldsFromDetail(sent),
      summary: ' A ride at 9 ',
      timing: '',
      destination: '',
    };
    expect(requestEdit(fields, sent)).toEqual({
      summary: 'A ride at 9',
      timing: null,
      destination: null,
    });
  });
});
