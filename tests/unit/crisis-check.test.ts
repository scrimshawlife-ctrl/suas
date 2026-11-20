/**
 * Crisis-language check before the model (R17.4, contributor proposal, not released): every
 * approved phrase matches after normalizing, and near-misses on word boundaries do not.
 */

import { describe, expect, it } from 'vitest';
import { ScriptedModelInference } from '../../src/inference/index.js';
import { EMPTY_DRAFT_FIELDS, runIntakeAssistant } from '../../src/intake/assistant.js';
import { CRISIS_PHRASES, detectCrisisLanguage } from '../../src/intake/crisis-check.js';

describe('detectCrisisLanguage', () => {
  it.each(CRISIS_PHRASES)('matches the phrase "%s" inside a sentence', (phrase) => {
    expect(detectCrisisLanguage(`Honestly, ${phrase} is how I feel today.`)).toBe(true);
  });

  it.each([
    ['upper case and extra spaces', 'I  WANT   TO DIE'],
    ['punctuation between words', 'I want to... end. my. life'],
    ['a hyphen', 'I have been thinking about self-harm'],
    ['a curly apostrophe', 'I can’t go on like this'],
    ['a line break', 'I might\nhurt myself tonight'],
    ['the end of the text', 'Thinking about suicide.'],
    ['a trailing period', 'Some days I just want to unalive.'],
    ['mixed case', 'I keep thinking about UnAliving myself'],
    ['a past tense', 'My buddy unalived last year and I think about it'],
    ['a slang spelling', 'sewerslide has been on my mind'],
    ['a comma after the phrase', 'I want to end it all, honestly'],
    ['an -ing form', 'Ending it all seems easier'],
    ['"off myself"', 'I might off myself.'],
    ['"offing myself"', 'Thinking about offing myself tonight'],
    ['"not worth living"', 'Life is not worth living anymore!'],
    ['an apostrophe', "I don't want to be here anymore"],
    ['no apostrophe', 'I dont want to be here anymore'],
    ['a curly apostrophe and caps', 'I DON’T WANT TO LIVE like this'],
    ['no apostrophe, lower case', 'i dont want to live'],
    ['"kill me"', 'Someone just kill me.'],
  ])('matches with %s', (_name, text) => {
    expect(detectCrisisLanguage(text)).toBe(true);
  });

  // R17.x (contributor's call, D-064): Unicode look-alikes and invisible characters are undone.
  it.each([
    ['full-width letters', 'I keep thinking about ｓｕｉｃｉｄｅ'],
    ['a zero-width space inside a word', 'thinking about sui\u200Bcide'],
    ['a soft hyphen and a word joiner', 'I want to kill my\u00ADse\u2060lf'],
    ['Cyrillic look-alikes', 'I am su\u0456\u0441\u0456d\u0430l'],
    ['a Greek omicron', 'I want to end my life, n\u03BF reason to live'],
    ['an RTL override', 'I want to \u202Ekill myself\u202C tonight'],
  ])('matches with %s', (_name, text) => {
    expect(detectCrisisLanguage(text)).toBe(true);
  });

  it.each([
    ['an ordinary food request', 'I need groceries by Friday.'],
    ['a ride request', 'Can someone drive me to the pharmacy?'],
    ['a word that only contains a phrase', 'The batteries died, I want to diesel up the truck.'],
    ['a phrase split across other words', 'I want to go to the store; die-cast models are fun.'],
    ['a similar but different word', 'My suicidality screening was fine; my car is a write-off.'],
    ['empty text', ''],
    ['a distance in kms', 'It is 12 kms to the clinic.'],
    ['an engine', 'Please kill the engine before you get out.'],
    ['a figure of speech', 'The deadline is killing me.'],
    ['a lease', 'I need to end my lease early.'],
    ['a word containing "kms"', 'Skills matter when you look for work.'],
  ])('does not match %s', (_name, text) => {
    expect(detectCrisisLanguage(text)).toBe(false);
  });
});

describe('runIntakeAssistant crisis check', () => {
  const host = { searchResources: () => Promise.resolve([]) };

  // The draft fields go to the model too, and a Veteran can edit them directly.
  it.each(['summary', 'timing', 'meetingPlace', 'destination'] as const)(
    'answers CRISIS_SUPPORT with no model call when only the draft %s has crisis words',
    async (field) => {
      const port = new ScriptedModelInference().enqueue({ ok: true, text: 'Hi', toolCalls: [] });
      const run = await runIntakeAssistant(port, host, {
        intakeText: 'I need a ride on Friday.',
        draft: {
          ...EMPTY_DRAFT_FIELDS,
          category: 'TRANSPORTATION',
          summary: 'Ride to the clinic',
          [field]: 'I want to end my life',
        },
      });
      expect(run.outcome).toBe('CRISIS_SUPPORT');
      expect(port.requests()).toHaveLength(0);
    },
  );

  it('asks the model when neither the text nor the draft has crisis words', async () => {
    const port = new ScriptedModelInference().enqueue({ ok: true, text: 'Hi', toolCalls: [] });
    const run = await runIntakeAssistant(port, host, {
      intakeText: 'I need a ride on Friday.',
      draft: { ...EMPTY_DRAFT_FIELDS, category: 'TRANSPORTATION', summary: 'Ride to the clinic' },
    });
    expect(run.outcome).toBe('DRAFT_READY');
    expect(port.requests()).toHaveLength(1);
  });
});
