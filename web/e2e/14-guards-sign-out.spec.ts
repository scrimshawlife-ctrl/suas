import { expect, test } from '@playwright/test';
import { API_URL } from './config';
import { signInWithCode, signUp, uniqueEmail } from './helpers';

test('signed out, /home and /request go to sign in', async ({ page }) => {
  for (const path of ['/home', '/request']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in$/);
  }
});

test('signed in without a profile, app routes go to /welcome', async ({ page, request }) => {
  await signInWithCode(page, request, uniqueEmail('no-profile'));
  await expect(page).toHaveURL(/\/welcome$/);
  for (const path of ['/home', '/request', '/serve']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/welcome$/);
  }
});

test('with a profile but no ID check, /request goes to /verify', async ({ page, request }) => {
  await signUp(page, request, {
    email: uniqueEmail('unverified'),
    name: 'Jo K.',
    county: 'Merced',
  });
  await page.goto('/request');
  await expect(page).toHaveURL(/\/verify$/);
});

test('signing out ends on the landing page and revokes the session', async ({ page, request }) => {
  await signUp(page, request, { email: uniqueEmail('leaver'), name: 'Rae M.', county: 'Merced' });
  const token = await page.evaluate(() => sessionStorage.getItem('suas.session'));
  expect(token).toBeTruthy();

  await page.getByRole('button', { name: 'Account and sign out for Rae' }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/:\d+\/$/);
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('suas.session'))).toBeNull();

  // The server revoked the session, so the old token no longer works anywhere.
  const me = await request.get(`${API_URL}/api/v0/veterans/me`, {
    headers: { authorization: `Bearer ${token ?? ''}` },
  });
  expect(me.status()).toBe(401);

  await page.goto('/home');
  await expect(page).toHaveURL(/\/sign-in$/);
});
