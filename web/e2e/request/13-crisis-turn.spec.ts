import { expect, test } from '../fixtures';
import { tag } from '../helpers';
import { newVeteran } from '../people';

// R17.4 (contributor proposal, not released): crisis language is answered before any model
// call. No model turns are scripted, so a model call would come back FALLBACK_FORM instead.
test('crisis words get the crisis panel at once, and the form stays ready below', async ({
  browser,
  request,
}) => {
  const { page } = await newVeteran(browser, request, { name: 'Rory Q.' });
  const typed = `I need groceries and I want to end my life ${tag()}`;
  const reply = page.waitForResponse(
    (r) => r.request().method() === 'POST' && /\/api\/v0\/intake\/drafts$/.test(r.url()),
  );
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill(typed);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const turn = (await (await reply).json()) as { outcome: string; draft: unknown };
  expect(turn).toMatchObject({ outcome: 'CRISIS_SUPPORT', draft: null });

  const conversation = page.getByRole('list', { name: 'Conversation' });
  await expect(conversation.getByRole('heading', { name: 'Need help right now?' })).toBeVisible();
  await expect(conversation.getByRole('link', { name: 'Call 911' })).toHaveAttribute(
    'href',
    'tel:911',
  );
  await expect(
    conversation.getByRole('link', { name: 'Veterans Crisis Line: Text 838255' }),
  ).toHaveAttribute('href', 'sms:838255');

  // The assistant stays open and the plain form is still there, empty, for a request.
  await expect(page.getByLabel('Tell us what you need')).toBeVisible();
  const form = page.getByRole('form', { name: 'Request form' });
  await expect(form).toBeVisible();
  await expect(form.getByLabel('Short summary')).toHaveValue('');
});
