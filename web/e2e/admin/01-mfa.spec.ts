import { expect, test } from '../fixtures';
import type { APIRequestContext, Page } from '@playwright/test';
import { API_URL } from '../config';
import { myUserId, newPerson, readSignInCode, shoot } from '../helpers';
import { expireSessions } from '../time/time';
import { errorCode, expectNoDeadControls, nextResponse, resetSignInLimits } from '../auth/auth';
import { ADMIN_EMAIL, passMfa, signInAdmin, testFactorResponse } from './admin';

const MFA_VERIFY = /\/api\/v0\/auth\/mfa\/challenges\/commands\/verify$/;
const DRAFTS = /\/api\/v0\/admin\/resource-drafts$/;

/** Signs the seeded admin in again from /sign-in (the page an expired session lands on). */
async function signInAgain(page: Page, request: APIRequestContext): Promise<void> {
  await resetSignInLimits(ADMIN_EMAIL);
  await page.getByRole('radio', { name: /I need support/ }).check();
  await page.getByLabel('Email address').fill(ADMIN_EMAIL);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await page.getByLabel('6-digit code').fill(await readSignInCode(request, ADMIN_EMAIL));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
}

test('signed out, every admin address goes to sign in, and the admin comes back after the step-up', async ({
  browser,
  request,
}) => {
  const page = await newPerson(browser);
  for (const path of ['/admin', '/admin/drafts', '/admin/mfa', '/admin/drafts/abc']) {
    await page.goto(path);
    await expect(page, `${path} signed out`).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { name: 'Overview' })).toHaveCount(0);
  }
  // Signed out on /admin/drafts, then sign in: the guards send the admin to the step-up
  // first, then back to the drafts.
  await page.goto('/admin/drafts');
  await expect(page).toHaveURL(/\/sign-in$/);
  await signInAgain(page, request);
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await passMfa(page);
  await expect(page).toHaveURL(/\/admin\/drafts$/);
});

test('an admin opening the console steps up first, and lands on the page that sent them', async ({
  browser,
  request,
}) => {
  const page = await signInAdmin(browser, request);
  await page.goto('/admin/drafts?status=PUBLISHED');
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Confirm it is you' })).toBeVisible();
  await expect(page).toHaveTitle('Confirm it is you · SUAS');
  // No admin data before the step-up.
  await expect(page.getByRole('heading', { name: 'Resource drafts' })).toHaveCount(0);
  await expectNoDeadControls(page);
  await shoot(page, 'admin-01-mfa-start');

  await page.getByRole('button', { name: 'Start check' }).click();
  await expect(page.getByText('This environment uses a test check.')).toBeVisible();
  await expectNoDeadControls(page);

  // Empty or spaces only: a field error, focus on the field, no request.
  for (const empty of ['', '   ']) {
    await page.getByLabel('Your response').fill(empty);
    await page.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Enter your response.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Your response')).toBeFocused();
  }

  await page.getByLabel('Your response').fill(await testFactorResponse(page));
  await page.getByRole('button', { name: 'Confirm' }).click();
  // Back to where the guard stopped them, query string included.
  await expect(page).toHaveURL(/\/admin\/drafts\?status=PUBLISHED$/);
  await expect(page.getByRole('button', { name: 'Published', pressed: true })).toBeVisible();
  await expect(page).toHaveTitle('Resource drafts · SUAS Admin');

  // The step-up page was replaced in history: Back does not show it again.
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/drafts\?status=PUBLISHED$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Resource drafts' })).toBeVisible();
});

test('a wrong response is a real 401, the old check is spent, and a new check works', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the browser logs each refused load.
  allow.push(/status of 401/);
  const page = await signInAdmin(browser, request);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Start check' }).click();
  const good = await testFactorResponse(page);
  await page.getByLabel('Your response').fill('ok-not-the-right-one');
  const refused = nextResponse(page, 'POST', MFA_VERIFY);
  await page.getByRole('button', { name: 'Confirm' }).click();
  expect((await refused).status()).toBe(401);
  await expect(page.getByRole('alert')).toHaveText(
    'That response did not match. Each check works once, so start a new check and try again.',
  );
  // The admin is still signed in and still on the step-up.
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  expect(await page.evaluate(() => sessionStorage.getItem('suas.session'))).toBeTruthy();
  await expect(page.getByLabel('Your response')).toHaveCount(0);
  await shoot(page, 'admin-01-mfa-wrong');

  // The spent check's right answer no longer works (single use).
  const token = await page.evaluate(() => sessionStorage.getItem('suas.session'));
  const replay = await request.post(`${API_URL}/api/v0/auth/mfa/challenges/commands/verify`, {
    headers: { authorization: `Bearer ${token ?? ''}` },
    data: { challenge_id: good.replace(/^ok-/, ''), response: good },
  });
  expect(replay.status()).toBe(401);

  await page.getByRole('button', { name: 'Start a new check' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Your response')).toHaveValue('');
  await page.getByLabel('Your response').fill(await testFactorResponse(page));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
});

test('double-clicking Start check and Confirm starts one check and sends one response', async ({
  browser,
  request,
}) => {
  const page = await signInAdmin(browser, request);
  const posts: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/auth/mfa/challenges')) posts.push(r.url());
  });
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Start check' }).dblclick();
  await expect(page.getByLabel('Your response')).toBeVisible();
  // The check on screen is the one that works.
  await page.getByLabel('Your response').fill(await testFactorResponse(page));
  await page.getByRole('button', { name: 'Confirm' }).dblclick();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  expect(posts.filter((url) => url.endsWith('/auth/mfa/challenges'))).toHaveLength(1);
  expect(posts.filter((url) => url.endsWith('/commands/verify'))).toHaveLength(1);
});

test('Back from the step-up returns to the app; refresh mid-check starts over and still returns', async ({
  browser,
  request,
}) => {
  const page = await signInAdmin(browser, request);
  await page.goto('/admin/drafts');
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await page.getByRole('button', { name: 'Start check' }).click();
  await expect(page.getByLabel('Your response')).toBeVisible();
  await page.reload();
  // The check in progress is gone after a reload; the page offers a new one.
  await expect(page.getByRole('button', { name: 'Start check' })).toBeVisible();
  await passMfa(page);
  // The return path survives the reload (it lives in the history entry).
  await expect(page).toHaveURL(/\/admin\/drafts$/);
});

test('once stepped up, the console nav works without a new check', async ({ browser, request }) => {
  const page = await signInAdmin(browser, request);
  await page.goto('/admin');
  await passMfa(page);
  // Opening the step-up address again still shows the step-up (QA ADMIN-3, spec question).
  await page.goto('/admin/mfa');
  await expect(page.getByRole('heading', { level: 1, name: 'Confirm it is you' })).toBeVisible();
  await page.getByRole('link', { name: 'Resource drafts' }).click();
  await expect(page).toHaveURL(/\/admin\/drafts$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Resource drafts' })).toBeVisible();
});

// The client's MFA flag only steers the guard; the server decides. A flag left over in the tab
// (here written by hand) lets the page ask, the API answers 403 MFA_REQUIRED, and the app
// clears the flag and goes to the step-up, then back.
test('a stale client MFA flag gets a real 403 MFA_REQUIRED and goes to the step-up', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the browser logs each refused load.
  allow.push(/status of 403/);
  const page = await signInAdmin(browser, request);
  await page.evaluate(() => sessionStorage.setItem('suas.mfa', '1'));
  const refused = nextResponse(page, 'GET', DRAFTS);
  await page.goto('/admin/drafts');
  const response = await refused;
  expect(response.status()).toBe(403);
  expect(await errorCode(response)).toBe('MFA_REQUIRED');
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  expect(await page.evaluate(() => sessionStorage.getItem('suas.mfa'))).toBeNull();
  await passMfa(page);
  await expect(page).toHaveURL(/\/admin\/drafts$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Resource drafts' })).toBeVisible();
});

test('when the admin session itself expires, the console goes to sign in, then step-up, then back', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the browser logs each refused load.
  allow.push(/status of 401/);
  const page = await signInAdmin(browser, request);
  await page.goto('/admin/drafts?status=REJECTED');
  await passMfa(page);
  await expect(page).toHaveURL(/\/admin\/drafts\?status=REJECTED$/);
  await expireSessions(await myUserId(page, request));
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(await page.evaluate(() => sessionStorage.getItem('suas.mfa'))).toBeNull();
  await signInAgain(page, request);
  // A new session is not stepped up, so the check comes first, then the page they were on.
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await passMfa(page);
  await expect(page).toHaveURL(/\/admin\/drafts\?status=REJECTED$/);
});

// ADMIN-8 regression: a second 401 arriving after the redirect must not overwrite the
// return path with /sign-in. Reads are held (not faked) so they answer one after the other.
test('when two admin requests hit the expired session at once, sign-in still returns to the page', async ({
  browser,
  request,
  allow,
}) => {
  // Provoked on purpose: the browser logs each refused load.
  allow.push(/status of 401/);
  const page = await signInAdmin(browser, request);
  await page.goto('/admin/drafts');
  await passMfa(page);
  await expect(page.getByRole('button', { name: 'To review', pressed: true })).toBeVisible();
  const held: { url: string; go: () => void }[] = [];
  await page.route('**/api/v0/**', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await new Promise<void>((go) => held.push({ url: route.request().url(), go }));
    await route.fallback();
  });
  await page.waitForLoadState('networkidle');
  await expireSessions(await myUserId(page, request));
  const lists = () => held.filter((h) => h.url.includes('/admin/resource-drafts?'));
  await page.getByRole('button', { name: 'Published' }).click();
  await page.getByRole('button', { name: 'Discarded' }).click();
  await expect.poll(() => lists().length).toBe(2);
  lists()[0]?.go();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByLabel('Email address')).toBeVisible();
  const second = page.waitForResponse((r) => r.url() === lists()[1]?.url);
  lists()[1]?.go();
  await second;
  await page.unroute('**/api/v0/**');
  held.forEach((h) => h.go());
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/\/sign-in$/);
  await signInAgain(page, request);
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await passMfa(page);
  await expect(page).toHaveURL(/\/admin\/drafts\?status=REJECTED$/);
});
