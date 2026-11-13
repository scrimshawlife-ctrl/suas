import { expect, test } from '@playwright/test';
import { readSignInCode, withDb } from '../helpers';
import {
  LANDING,
  enterCode,
  errorCode,
  nextResponse,
  signOutFromAvatar,
  signedUpPerson,
} from './auth';

const VERIFY = /\/api\/v0\/auth\/challenges\/commands\/verify$/;

// M6: sessions live in sessionStorage, so a duplicated tab holds the same session. Signing
// out in one revokes it on the server; the other tab's next read is a 401.
test('a session signed out in another tab sends this tab to sign in, then back where it was', async ({
  browser,
  request,
}) => {
  const { page, email } = await signedUpPerson(browser, request, {
    label: 'two-tabs',
    name: 'Uli G.',
  });
  const token = await page.evaluate(() => sessionStorage.getItem('suas.session'));
  const other = await page.context().newPage();
  await other.goto('/');
  await other.evaluate((value) => sessionStorage.setItem('suas.session', value ?? ''), token);
  await other.goto('/home');
  await expect(other.getByText(/Good (morning|afternoon|evening), Uli\./)).toBeVisible();
  await other.waitForLoadState('networkidle');
  await signOutFromAvatar(other, 'Uli');
  await expect(other).toHaveURL(LANDING);

  // The first tab still shows Home; moving to Serve in the app reads with the revoked session.
  await expect(page.getByText(/Good (morning|afternoon|evening), Uli\./)).toBeVisible();
  const refused = nextResponse(page, 'GET', /\/api\/v0\//);
  await page.getByRole('link', { name: 'Serve' }).first().click();
  expect((await refused).status()).toBe(401);
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText('Uli')).toHaveCount(0);

  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await enterCode(page, await readSignInCode(request, email));
  await expect(page).toHaveURL(/\/serve$/);
});

// G11 / R12.6 (decision O8 a): there is no SUSPENDED screen. Session resolution refuses a
// non-ACTIVE user, so the web gets a 401 and goes to sign-in, and no new code is delivered.
test('a person suspended mid-session is sent to sign in on their next read and cannot sign back in', async ({
  browser,
  request,
}) => {
  const { page, email } = await signedUpPerson(browser, request, {
    label: 'suspended',
    name: 'Sol M.',
  });
  const usedCode = await readSignInCode(request, email);
  await withDb((db) =>
    db.query(`UPDATE users SET status = 'SUSPENDED' WHERE lower(email) = lower($1)`, [email]),
  );

  const refused = nextResponse(page, 'GET', /\/api\/v0\//);
  await page.getByRole('link', { name: 'Serve' }).first().click();
  const response = await refused;
  expect(response.status()).toBe(401);
  expect(await errorCode(response)).toBe('UNAUTHENTICATED');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText('Sol')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('suas.session'))).toBeNull();

  // Asking for a code looks the same as for anyone (no account enumeration), but no code is
  // delivered: the last code the fake mailbox holds is the used one, and it is refused.
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  expect(await readSignInCode(request, email)).toBe(usedCode);
  const verify = nextResponse(page, 'POST', VERIFY);
  await enterCode(page, usedCode);
  expect((await verify).status()).toBe(401);
  await expect(page.getByText('The sign-in code is invalid or has expired.')).toBeVisible();
});
