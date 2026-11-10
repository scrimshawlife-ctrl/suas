import { expect, test } from '@playwright/test';
import { expectCrisisScreen, shoot, signUp, uniqueEmail } from './helpers';

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
