import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL } from './config';
import { signInWithCode, signUp, uniqueEmail } from './helpers';

/** The request, case and notification reads a page makes; a guard must redirect before any. */
function caseReads(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (sent) => {
    if (/\/api\/v0\/(service-requests|cases|notifications)\b/.test(sent.url()))
      seen.push(sent.url());
  });
  return seen;
}

const SERVE_PATHS = ['/serve', `/serve/requests/${randomUUID()}`];

test('signed out, /home, /request and Serve go to sign in, with no case read', async ({ page }) => {
  const reads = caseReads(page);
  for (const path of ['/home', '/request', ...SERVE_PATHS]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/sign-in$/);
  }
  expect(reads).toEqual([]);
});

test('signed in without a profile, app routes go to /welcome, with no case read', async ({
  page,
  request,
}) => {
  await signInWithCode(page, request, uniqueEmail('no-profile'));
  await expect(page).toHaveURL(/\/welcome$/);
  const reads = caseReads(page);
  for (const path of ['/home', '/request', ...SERVE_PATHS]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/welcome$/);
  }
  expect(reads).toEqual([]);
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
