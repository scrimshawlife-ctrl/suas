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
      contact_method: '',
    });
    expect(errors.service_name).toBeDefined();
    expect(errors.category).toBeDefined();
    expect(errors.contact_method_kind).toMatch(/contact method/);
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

  it('sends null for a cleared optional field and for a cleared kind', () => {
    const values = {
      ...draftToForm(draft),
      hours: '',
      contact_method: '',
      contact_method_kind: '' as const,
    };
    expect(buildEditPayload(draft, values)).toEqual({
      hours: null,
      contact_method: null,
      contact_method_kind: null,
    });
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
