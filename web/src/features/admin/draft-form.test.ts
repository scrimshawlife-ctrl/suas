import { describe, expect, it } from 'vitest';
import {
  buildEditPayload,
  draftToForm,
  LIMITS,
  validateDraftForm,
  validateExtract,
} from './draft-form';
import { makeDraft } from './test-utils';

describe('validateExtract', () => {
  const ok = {
    source_text: 'Valley Pantry, free food',
    source_link: 'https://a.example.invalid/x',
  };

  it('accepts text with an http or https link', () => {
    expect(validateExtract(ok)).toEqual({});
    expect(validateExtract({ ...ok, source_link: 'http://a.example.invalid' })).toEqual({});
  });

  it('requires both fields', () => {
    const errors = validateExtract({ source_text: '   ', source_link: '' });
    expect(errors.source_text).toBe('Paste the source text.');
    expect(errors.source_link).toBe('Enter the link to the source.');
  });

  it('refuses links that are not http or https', () => {
    for (const link of [
      'ftp://a.example.invalid',
      'javascript:alert(1)',
      'not a url',
      'a.example.invalid',
    ]) {
      expect(validateExtract({ ...ok, source_link: link }).source_link).toMatch(/http/);
    }
  });

  it('allows exactly 30,000 characters and refuses one more', () => {
    expect(validateExtract({ ...ok, source_text: 'a'.repeat(LIMITS.sourceText) })).toEqual({});
    expect(
      validateExtract({ ...ok, source_text: 'a'.repeat(LIMITS.sourceText + 1) }).source_text,
    ).toMatch(/over 30,000 characters/);
  });
});

describe('validateDraftForm', () => {
  it('needs a name and a category, and a contact method for a kind', () => {
    const base = draftToForm(makeDraft());
    expect(validateDraftForm(base)).toEqual({});
    const errors = validateDraftForm({
      ...base,
      service_name: ' ',
      category: '',
    });
    expect(errors.service_name).toBeDefined();
    expect(errors.category).toBeDefined();
  });

  it('refuses a contact row with no value and an area over 80 characters', () => {
    const base = draftToForm(makeDraft());
    const blank = validateDraftForm({ ...base, contacts: [{ kind: 'URL', value: '  ' }] });
    expect(blank.contacts).toMatch(/Enter each contact method/);
    const area = validateDraftForm({ ...base, area: 'a'.repeat(LIMITS.area + 1) });
    expect(area.area).toMatch(/over 80 characters/);
  });
});

describe('buildEditPayload', () => {
  const draft = makeDraft();

  it('is null when nothing changed', () => {
    expect(buildEditPayload(draft, draftToForm(draft))).toBeNull();
  });

  it('sends only the changed fields, trimmed', () => {
    const values = { ...draftToForm(draft), service_name: '  New name ', cost: ' Free ' };
    expect(buildEditPayload(draft, values)).toEqual({ service_name: 'New name', cost: 'Free' });
  });

  it('sends null for a cleared optional field', () => {
    const values = { ...draftToForm(draft), hours: '', area: '' };
    expect(buildEditPayload(draft, values)).toEqual({ hours: null });
    const withArea = makeDraft({ area: 'San José' });
    expect(buildEditPayload(withArea, { ...draftToForm(withArea), area: '' })).toEqual({
      area: null,
    });
  });

  it('sends the contact list and area without the legacy single fields', () => {
    const values = {
      ...draftToForm(draft),
      contacts: [
        { kind: 'PHONE' as const, value: ' 408-555-0100 ' },
        { kind: 'URL' as const, value: 'https://example.org' },
      ],
      area: ' San José, east side ',
    };
    const payload = buildEditPayload(draft, values);
    expect(payload).toEqual({
      contacts: [
        { kind: 'PHONE', value: '408-555-0100' },
        { kind: 'URL', value: 'https://example.org' },
      ],
      area: 'San José, east side',
    });
    expect(payload).not.toHaveProperty('contact_method');
    expect(payload).not.toHaveProperty('contact_method_kind');
  });

  it('sends null when every contact is removed, and nothing when only spacing differs', () => {
    expect(buildEditPayload(draft, { ...draftToForm(draft), contacts: [] })).toEqual({
      contacts: null,
    });
    const spaced = {
      ...draftToForm(draft),
      contacts: [{ kind: 'PHONE' as const, value: ' 408-555-0100 ' }],
    };
    expect(buildEditPayload(draft, spaced)).toBeNull();
  });

  it('sends counties in canonical order, and an empty list when all are cleared', () => {
    const values = {
      ...draftToForm(draft),
      counties: ['ALAMEDA' as const, 'SANTA_CLARA' as const],
    };
    expect(buildEditPayload(draft, values)).toEqual({ counties: ['SANTA_CLARA', 'ALAMEDA'] });
    expect(buildEditPayload(draft, { ...values, counties: [] })).toEqual({ counties: [] });
  });

  it('sends a changed category', () => {
    expect(buildEditPayload(draft, { ...draftToForm(draft), category: 'SHELTER' })).toEqual({
      category: 'SHELTER',
    });
  });
});
