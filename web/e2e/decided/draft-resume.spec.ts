import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { draftTurns, newVerifiedVeteran, scriptModel, uniqueEmail } from '../helpers';

/** R12.1 (contributor proposal, SUAS-specs #79): the open draft comes back after a reload. */
const storedDraftId = (page: Page) =>
  page.evaluate(() => sessionStorage.getItem('suas.intake-draft'));

test('an open intake draft survives a reload, and its id is dropped on submit and sign-out', async ({
  browser,
  request,
}) => {
  const { page } = await newVerifiedVeteran(browser, request, {
    name: 'Dana R.',
    county: 'Santa Clara',
    label: 'resume',
  });
  const summary = `Groceries for the week ${uniqueEmail('x').slice(6, 14)}`;
  const typed = 'I could use some groceries this week.';

  await scriptModel(request, draftTurns({ category: 'FOOD', summary }));
  await page.goto('/request');
  await page.getByLabel('Tell us what you need').fill(typed);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const card = page.getByRole('region', { name: 'Check your request' });
  await expect(card.getByLabel('Short summary')).toHaveValue(summary);
  expect(await storedDraftId(page)).toMatch(/^[0-9a-f-]{36}$/);

  // A reload keeps the draft and what was typed; the assistant's replies are not restored.
  await page.reload();
  await expect(card.getByLabel('Short summary')).toHaveValue(summary);
  await expect(page.getByText('You wrote')).toBeVisible();
  await expect(page.getByText(typed)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Conversation' })).toHaveCount(0);

  // Submitting the resumed draft sends the request and forgets the id.
  await card.getByLabel('Where should the helper meet you?').fill('Front entrance of the library');
  await card.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  expect(await storedDraftId(page)).toBeNull();
  await page.goto('/request');
  await expect(page.getByLabel('Tell us what you need')).toBeVisible();
  await expect(card).toHaveCount(0);

  // A new draft's id is dropped on sign-out, so the next person in this tab cannot resume it.
  await scriptModel(request, draftTurns({ category: 'FOOD', summary: `${summary} again` }));
  await page.getByLabel('Tell us what you need').fill(typed);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(card).toBeVisible();
  expect(await storedDraftId(page)).not.toBeNull();
  await page.getByRole('button', { name: /^Account and sign out for / }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  expect(await storedDraftId(page)).toBeNull();
});
