import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { runJobWorkerOnce } from '../helpers';
import { ageCheckIns, closePeople, myUserId, startCheckIn, veteran } from '../support/support';

test.afterEach(closePeople);

const EXPIRED = 'This Check-In can no longer be finished. You can start a new one.';

/** Answers question 1 so the Check-In is in progress, leaving the screen on question 2. */
async function answerFirst(page: Page): Promise<void> {
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByText('Question 2 of 9')).toBeVisible();
}

test('T3: an answer past the 24-hour window, before the sweep, is refused 409 and "Start again" starts a new one', async ({
  browser,
  request,
  allow,
}) => {
  // The past-window answer is refused on purpose.
  allow.push(/status of 409/);
  const { page } = await veteran(browser, request, { name: 'Flo M.', county: 'Alameda' });
  await startCheckIn(page);
  await answerFirst(page);
  await ageCheckIns(await myUserId(page, request));

  // The sweep has not run: the row is still IN_PROGRESS, and the API refuses the answer.
  const saved = page.waitForResponse((r) => /\/check-ins\/[^/]+\/responses$/.test(r.url()));
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Save answer' }).click();
  expect((await saved).status()).toBe(409);
  await expect(page.getByRole('heading', { level: 1, name: EXPIRED })).toBeFocused();
  await expect(page.getByText('Check your connection')).toHaveCount(0);

  await page.getByRole('button', { name: 'Start again' }).click();
  await expect(page.getByText('Question 1 of 9')).toBeVisible();
});

test('T3: after the idle sweep abandons a Check-In, Home offers a new one and the open screen says why', async ({
  browser,
  request,
  allow,
}) => {
  // The abandoned Check-In refuses the answer on purpose.
  allow.push(/status of 409/);
  const { page } = await veteran(browser, request, { name: 'Gil M.', county: 'Alameda' });
  await startCheckIn(page);
  await answerFirst(page);
  await ageCheckIns(await myUserId(page, request));
  expect(runJobWorkerOnce()).toContain('"msg":"check_ins_abandoned"');

  // The screen still open on question 2 tries to save: the Check-In has ended.
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByRole('heading', { level: 1, name: EXPIRED })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start again' })).toBeVisible();

  // Home no longer offers to continue it; a new Check-In starts at question 1.
  await page.goto('/home');
  await expect(page.getByRole('link', { name: 'Start Check-In' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue Check-In' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Start Check-In' }).click();
  await expect(page.getByText('Question 1 of 9')).toBeVisible();
});
