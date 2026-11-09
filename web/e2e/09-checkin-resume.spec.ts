import { expect, test } from '@playwright/test';
import { newVerifiedVeteran } from './helpers';

test('a Veteran saves a Check-In to finish later, then resumes at the next question and completes', async ({
  browser,
  request,
}) => {
  const { page } = await newVerifiedVeteran(browser, request, {
    name: 'Rae K.',
    county: 'Alameda',
    label: 'resume',
  });

  // With nothing unfinished, Home offers a new Check-In.
  await page.getByRole('link', { name: 'Start Check-In' }).click();
  await expect(page.getByText(/^Question 1 of \d+$/)).toBeVisible();
  await page.getByRole('radio').first().check();
  await page.getByRole('button', { name: 'Save answer' }).click();
  await expect(page.getByText(/^Question 2 of \d+$/)).toBeVisible();

  // Leaving keeps the saved answer: Home now offers to continue.
  await page.getByRole('link', { name: 'Save and finish later' }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('link', { name: 'Continue Check-In' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Start Check-In' })).toHaveCount(0);

  // Reopening lands on question 2, not a new Check-In.
  await page.getByRole('link', { name: 'Continue Check-In' }).click();
  await expect(page.getByText(/^Question 2 of \d+$/)).toBeVisible();

  const done = page.getByRole('heading', { name: 'Thank you for checking in.' });
  for (let n = 2; ; n += 1) {
    await expect(
      page.getByText(new RegExp(`^Question ${String(n)} of \\d+$`)).or(done),
    ).toBeVisible();
    if (await done.isVisible()) break;
    await page.getByRole('radio').first().check();
    await page.getByRole('button', { name: 'Save answer' }).click();
  }
  await expect(page.getByText('Your answers are saved.')).toBeVisible();

  // A completed Check-In is not resumable: Home offers a new one again.
  await page.getByRole('link', { name: 'Back to home' }).click();
  await expect(page.getByRole('link', { name: 'Start Check-In' })).toBeVisible();
});
