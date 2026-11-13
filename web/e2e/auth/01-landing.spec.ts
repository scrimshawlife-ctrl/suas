import { expect, test, type Page } from '@playwright/test';
import { newPerson, shoot } from '../helpers';
import { LANDING, expectNoDeadControls, signedUpPerson } from './auth';

/** The crisis strip and footer links every screen carries (SAFETY_COPY.md §2.2, §2.3). */
async function expectCrisisLinks(page: Page): Promise<void> {
  for (const region of [
    page.getByRole('complementary', { name: 'Crisis support' }),
    page.getByRole('contentinfo'),
  ]) {
    await expect(region.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
    await expect(region.getByRole('link', { name: 'Call 988' })).toHaveAttribute('href', 'tel:988');
    await expect(region.getByRole('link', { name: 'Text 988' })).toHaveAttribute('href', 'sms:988');
    await expect(
      region.getByRole('link', { name: 'Veterans Crisis Line: Text 838255' }),
    ).toHaveAttribute('href', 'sms:838255');
  }
}

test('a visitor reads the landing page and every link goes somewhere real', async ({ browser }) => {
  const page = await newPerson(browser);
  await page.goto('/');
  await expect(page).toHaveTitle('SUAS · Veterans helping veterans');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Veterans helping veterans.' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
  await expectCrisisLinks(page);
  // The landing footer adds "Dial 988, then press 1".
  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'Dial 988' }),
  ).toHaveAttribute('href', 'tel:988');
  await expectNoDeadControls(page);
  await shoot(page, 'auth-landing-signed-out');

  // Each role link opens sign-in with that role chosen.
  await page.getByRole('link', { name: /I need support/ }).click();
  await expect(page).toHaveURL(/\/sign-in\?role=need$/);
  await expect(page.getByRole('radio', { name: /I need support/ })).toBeChecked();
  await page.goBack();
  await expect(page).toHaveURL(LANDING);
  await page.getByRole('link', { name: /I want to serve/ }).click();
  await expect(page).toHaveURL(/\/sign-in\?role=serve$/);
  await expect(page.getByRole('radio', { name: /I want to serve/ })).toBeChecked();

  // The sign-in screen hides its own Sign in button; the logo goes home.
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'SUAS home' }).click();
  await expect(page).toHaveURL(LANDING);
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goBack();
  await page.goForward();
  await expect(page).toHaveURL(/\/sign-in$/);

  // The crisis screen is open to signed-out people.
  await page.goto('/crisis');
  await expect(page.getByRole('heading', { level: 1, name: 'Immediate resources' })).toBeVisible();
});

test('a signed-in person on the landing page goes to their homes, not to sign-in', async ({
  browser,
  request,
}) => {
  const { page } = await signedUpPerson(browser, request, { label: 'landing-in', name: 'Lee P.' });
  await page.goto('/');
  // The header offers Sign out instead of Sign in.
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expectNoDeadControls(page);

  await page.getByRole('link', { name: /I need support/ }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.goBack();
  await page.getByRole('link', { name: /I want to serve/ }).click();
  await expect(page).toHaveURL(/\/serve$/);
  await page.goBack();
  await expect(page).toHaveURL(LANDING);
  // Serve's reads still in flight would race the sign-out.
  await page.waitForLoadState('networkidle');

  // Sign out from the landing header stays on the landing page, signed out.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page).toHaveURL(LANDING);
  expect(await page.evaluate(() => sessionStorage.getItem('suas.session'))).toBeNull();
});
