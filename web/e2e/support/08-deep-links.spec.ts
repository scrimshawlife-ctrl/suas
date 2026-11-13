import { expect, test } from '../fixtures';
import { readSignInCode } from '../helpers';
import { closePeople, veteran } from './support';

test.afterEach(closePeople);

const ROUTES = [
  { path: '/resources/food', title: 'Food · SUAS' },
  { path: '/check-in', title: 'Check-In · SUAS' },
  { path: '/trusted-contacts', title: 'Trusted contacts · SUAS' },
  { path: '/consents', title: 'What you share · SUAS' },
  { path: '/notifications', title: 'Notifications · SUAS' },
  { path: '/invitations', title: 'Invitations · SUAS' },
] as const;

test('signed out, each support address goes to sign in and comes back to it after the code', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  for (const route of ROUTES) {
    // Sign-in codes are rate limited per address, so each address gets its own Veteran.
    const vet = await veteran(browser, request, { name: 'Marcus T.', county: 'Santa Clara' });
    // A new tab has no session (it lives in sessionStorage), like a link opened from an email.
    const page = await vet.page.context().newPage();
    await page.goto(route.path);
    await expect(page, route.path).toHaveURL(/\/sign-in$/);
    await page.getByRole('radio', { name: /I need support/ }).check();
    await page.getByLabel('Email address').fill(vet.email);
    await page.getByRole('button', { name: 'Send sign-in code' }).click();
    await expect(page).toHaveURL(/\/sign-in\/code$/);
    await page.getByLabel('6-digit code').fill(await readSignInCode(request, vet.email));
    await page.getByRole('button', { name: 'Verify and continue' }).click();
    await expect(page, `back on ${route.path}`).toHaveURL(new RegExp(`${route.path}$`));
    await expect(page).toHaveTitle(route.title);
    // Back does not return to the code screen.
    await page.goBack();
    await expect(page).not.toHaveURL(/\/sign-in\/code$/);
    await closePeople();
  }
});

test('signed in without the ID check, each requester support address goes to Verify', async ({
  browser,
  request,
}) => {
  const { page } = await veteran(browser, request, {
    name: 'Pat V.',
    county: 'Alameda',
    verified: false,
  });
  for (const route of ROUTES.slice(0, 4)) {
    await page.goto(route.path);
    await expect(page, route.path).toHaveURL(/\/verify$/);
    await expect(page).toHaveTitle('Confirm you served · SUAS');
  }
  // Notifications and Invitations need no ID check.
  for (const route of ROUTES.slice(4)) {
    await page.goto(route.path);
    await expect(page).toHaveTitle(route.title);
  }
});
