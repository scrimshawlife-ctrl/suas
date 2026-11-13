import { expect, test } from '../fixtures';
import {
  answerRest,
  closePeople,
  DONE_HEADING,
  serverError,
  startCheckIn,
  veteran,
} from './support';

test.afterEach(closePeople);

test('a Check-In: Save waits for a choice, Previous keeps the saved answer, optional questions skip', async ({
  browser,
  request,
}) => {
  const { page } = await veteran(browser, request, { name: 'Rae K.', county: 'Alameda' });
  await startCheckIn(page);
  await expect(page).toHaveTitle('Check-In · SUAS');
  await expect(page.getByText('Question 1 of 9')).toBeVisible();

  // The first question is required: no Skip, no Previous, Save off until a choice.
  await expect(page.getByRole('button', { name: 'Save answer' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Skip this question' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous question' })).toHaveCount(0);
  await page.getByRole('radio', { name: 'A little', exact: true }).check();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByText('Question 2 of 9')).toBeVisible();

  // Previous shows question 1 with the saved choice; a new choice saves and moves on again.
  await page.getByRole('button', { name: 'Previous question' }).click();
  await expect(page.getByText('Question 1 of 9')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'A little', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Not at all', exact: true }).check();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByText('Question 2 of 9')).toBeVisible();

  // The three optional questions offer Skip; skipping them still completes.
  const seen = await answerRest(page, { urgency: 'skip', reachable: 'skip', danger: 'skip' });
  expect(seen).toEqual([
    'connection',
    'stress',
    'basicNeeds',
    'urgency',
    'coping',
    'reachable',
    'safeNow',
    'danger',
  ]);
  await expect(page.getByRole('heading', { level: 1, name: DONE_HEADING })).toBeVisible();
  await expect(page.getByText('Your answers are saved.')).toBeVisible();
});

test('when saving an answer fails, the page says so, keeps the choice, and the next Save works', async ({
  browser,
  request,
  allow,
}) => {
  // The 500 is the one this test returns on purpose.
  // Only the routed answer save may 500; a real backend 500 still fails the test.
  allow.push(/\/check-ins\/[^/]+\/responses :: 500$/, /status of 500/);
  const { page } = await veteran(browser, request, { name: 'Di F.', county: 'Alameda' });
  await startCheckIn(page);
  await page.route('**/api/v0/check-ins/*/responses', (route) => route.fulfill(serverError()));
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Something went wrong on our side. Try to save your answer again.',
  );
  await expect(page.getByText('Question 1 of 9')).toBeVisible();
  await expect(page.getByRole('radio').first()).toBeChecked();

  await page.unroute('**/api/v0/check-ins/*/responses');
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByText('Question 2 of 9')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
