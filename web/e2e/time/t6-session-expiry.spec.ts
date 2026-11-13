import { expect, test } from '../fixtures';
import { readSignInCode, uniqueEmail } from '../helpers';
import { closePeople, myUserId, veteran } from '../support/support';
import { expireSessions, idleSessions } from './time';

test.afterEach(closePeople);

test('T6: past the absolute session end, the next action goes to sign in and the code brings the person back', async ({
  browser,
  request,
  allow,
}) => {
  // The expired session is refused on purpose.
  allow.push(/status of 401/);
  const vet = await veteran(browser, request, { name: 'Rae M.', county: 'Santa Clara' });
  const { page } = vet;
  // The page's reads finish before the session ends, so the write is what gets the 401.
  const consents = page.waitForResponse((r) => r.url().endsWith('/api/v0/consents'));
  await page.goto('/trusted-contacts');
  await consents;
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();
  await expireSessions(await myUserId(page, request));

  // Adding a contact is answered 401: the token is dropped and sign-in remembers the page.
  const posted = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v0/trusted-contacts'),
  );
  await page.getByLabel('Who is this to you?').fill('Sister');
  await page.getByLabel('Their email').fill(uniqueEmail('sister'));
  await page.getByRole('button', { name: 'Add trusted contact' }).click();
  expect((await posted).status()).toBe(401);
  await expect(page).toHaveURL(/\/sign-in$/);
  expect(await page.evaluate(() => sessionStorage.getItem('suas.session'))).toBeNull();

  await page.getByRole('radio', { name: /I need support/ }).check();
  await page.getByLabel('Email address').fill(vet.email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await page.getByLabel('6-digit code').fill(await readSignInCode(request, vet.email));
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page).toHaveURL(/\/trusted-contacts$/);
  await expect(page.getByText('You have not added anyone yet.')).toBeVisible();
});

test('T6: after two idle hours, opening a page goes to sign in', async ({
  browser,
  request,
  allow,
}) => {
  // The idle session is refused on purpose.
  allow.push(/status of 401/);
  const { page } = await veteran(browser, request, { name: 'Lee I.', county: 'Santa Clara' });
  await page.goto('/consents');
  await expect(page.getByRole('heading', { level: 1, name: 'What you share' })).toBeVisible();
  await idleSessions(await myUserId(page, request));
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in$/);
});
