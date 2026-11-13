import { expect, test, type Page } from '@playwright/test';
import { shoot, type CountyLabel } from '../helpers';
import {
  countRequests,
  errorCode,
  expectNoDeadControls,
  nextResponse,
  onWelcome,
  saveProfile,
} from './auth';

const COUNTIES: CountyLabel[] = [
  'Santa Clara',
  'San Mateo',
  'Alameda',
  'Santa Cruz',
  'San Benito',
  'Merced',
  'Stanislaus',
];
const PROFILE = /\/api\/v0\/veterans\/me\/profile$/;
const COUNTY = /\/api\/v0\/veterans\/me\/county$/;

const nameField = (page: Page) => page.getByLabel('Name other veterans will see');

/**
 * The page checks the same rules as the API, so the API's 400 cannot be reached by typing.
 * This rewrites the outgoing name to 41 characters; the real API answers.
 */
async function sendOverlongName(page: Page): Promise<void> {
  await page.route(PROFILE, (route) =>
    route.continue({ postData: JSON.stringify({ display_name: 'A'.repeat(41) }) }),
  );
}

test('the welcome form asks for a name and a county, in plain words', async ({
  browser,
  request,
}) => {
  const { page } = await onWelcome(browser, request, 'welcome-errors');
  await expect(page).toHaveTitle('Welcome · SUAS');
  await expect(page.getByRole('heading', { level: 1, name: 'Welcome to SUAS' })).toBeVisible();
  await expectNoDeadControls(page);
  const saves = countRequests(page, 'PUT', PROFILE);

  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Enter the name other veterans will see.')).toBeVisible();
  await expect(page.getByText('Choose your county.')).toBeVisible();
  await expect(nameField(page)).toBeFocused();

  await nameField(page).fill('   ');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Enter the name other veterans will see.')).toBeVisible();

  await nameField(page).fill('A'.repeat(41));
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Use 40 characters or fewer.')).toBeVisible();

  // A good name alone still needs the county; focus moves to it.
  await nameField(page).fill('Kai W.');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByText('Choose your county.')).toBeVisible();
  await expect(page.getByLabel('County')).toBeFocused();
  expect(saves(), 'nothing is saved while the form has errors').toBe(0);

  // The county list is the seven service counties, after the prompt.
  const options = await page.getByLabel('County').locator('option').allTextContents();
  expect(options).toEqual(['Choose your county', ...COUNTIES]);
  await shoot(page, 'auth-welcome-errors');
});

test('a profile the API refuses (400 VALIDATION_FAILED) keeps the person on the form to fix it', async ({
  browser,
  request,
}) => {
  const { page } = await onWelcome(browser, request, 'welcome-400');
  await sendOverlongName(page);
  const refused = nextResponse(page, 'PUT', PROFILE);
  await saveProfile(page, 'Kai W.', 'Merced');
  const response = await refused;
  expect(response.status()).toBe(400);
  expect(await errorCode(response)).toBe('VALIDATION_FAILED');
  await expect(page).toHaveURL(/\/welcome$/);
  // Plain words, not the API's field text ("display_name: String must contain …").
  await expect(
    page.getByText('We could not save that. Check your name and county, then try again.'),
  ).toBeVisible();
  await expect(page.getByText(/display_name|String must contain/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save and continue' })).toBeEnabled();

  // The next save, with the name as typed, goes through.
  await page.unroute(PROFILE);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(/\/home$/);
});

test('every county can be saved, and the form shows what was saved', async ({
  browser,
  request,
}) => {
  const { page } = await onWelcome(browser, request, 'welcome-counties');
  await saveProfile(page, 'Noa B.', 'Santa Clara');
  await expect(page).toHaveURL(/\/home$/);

  // Opening /welcome again shows the saved values.
  for (const county of COUNTIES) {
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { name: 'Welcome to SUAS' })).toBeVisible();
    await expect(nameField(page)).toHaveValue('Noa B.');
    await page.getByLabel('County').selectOption({ label: county });
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page).toHaveURL(/\/home$/);
    await page.goto('/welcome');
    await expect(page.getByLabel('County').locator('option:checked')).toHaveText(county);
  }
});

test('Back after saving the profile does not show the welcome form again', async ({
  browser,
  request,
}) => {
  const { page } = await onWelcome(browser, request, 'welcome-back');
  await saveProfile(page, 'Ray G.', 'Merced');
  await expect(page).toHaveURL(/\/home$/);
  await page.goBack();
  await expect(page).not.toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { name: 'Welcome to SUAS' })).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Welcome to SUAS' })).toHaveCount(0);
});

test('refreshing the welcome form keeps a helper signed in, and saving goes to Serve', async ({
  browser,
  request,
}) => {
  const { page } = await onWelcome(browser, request, 'welcome-refresh', 'serve');
  await nameField(page).fill('Ana Q.');
  await page.reload();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('heading', { name: 'Welcome to SUAS' })).toBeVisible();
  await saveProfile(page, 'Ana Q.', 'Stanislaus');
  await expect(page).toHaveURL(/\/serve$/);
});

test('double-clicking Save sends the profile once', async ({ browser, request }) => {
  const { page } = await onWelcome(browser, request, 'welcome-double');
  const profile = countRequests(page, 'PUT', PROFILE);
  const county = countRequests(page, 'PUT', COUNTY);
  await nameField(page).fill('Lou D.');
  await page.getByLabel('County').selectOption({ label: 'San Benito' });
  await page.getByRole('button', { name: 'Save and continue' }).dblclick();
  await expect(page).toHaveURL(/\/home$/);
  expect(profile()).toBe(1);
  expect(county()).toBe(1);
});

test('a failed save says so and the next try works', async ({ browser, request }) => {
  const { page } = await onWelcome(browser, request, 'welcome-500');
  // A 5xx cannot be reached on the real stack, so it is routed.
  await page.route(COUNTY, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
    }),
  );
  await saveProfile(page, 'Eli F.', 'Santa Cruz');
  await expect(
    page.getByText('We could not save that. Check your connection and try again.'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByRole('button', { name: 'Save and continue' })).toBeEnabled();
  await page.unroute(COUNTY);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page).toHaveURL(/\/home$/);
});
