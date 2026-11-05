import { expect, test, type Page } from '@playwright/test';
import { shoot, signUp, uniqueEmail } from './helpers';

/** The crisis screen: its heading, and 911 and 988 as red-flagged call buttons. */
async function expectCrisisScreen(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/crisis$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Immediate resources' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Call 911' }).first()).toHaveAttribute(
    'href',
    'tel:911',
  );
  await expect(page.getByRole('link', { name: 'Call or text 988' }).first()).toHaveAttribute(
    'href',
    'tel:988',
  );
}

test('the crisis screen opens signed out, and signed in without the ID check', async ({
  page,
  request,
}) => {
  await page.goto('/crisis');
  await expectCrisisScreen(page);
  // Signed out, there is no sign-in wall: "Continue with SUAS" is the only way on.
  await expect(page.getByRole('link', { name: 'Continue with SUAS' }).first()).toHaveAttribute(
    'href',
    '/sign-in',
  );
  await shoot(page, '06-crisis-signed-out');

  // Signed in with a profile but no ID check: Home offers the crisis panel, and it opens.
  await signUp(page, request, {
    email: uniqueEmail('unverified'),
    name: 'Pat V.',
    county: 'Alameda',
  });
  await page.getByRole('link', { name: 'More crisis options' }).click();
  await expectCrisisScreen(page);
  await expect(page.getByRole('link', { name: 'Continue with SUAS' }).first()).toHaveAttribute(
    'href',
    '/home',
  );
  await page.goto('/crisis');
  await expectCrisisScreen(page);
  await shoot(page, '06-crisis-unverified');
});
