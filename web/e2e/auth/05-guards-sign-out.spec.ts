import { expect, test } from '@playwright/test';
import { newPerson, readSignInCode, shoot, uniqueEmail } from '../helpers';
import {
  LANDING,
  enterCode,
  expectNoDeadControls,
  onWelcome,
  saveProfile,
  signOutFromAvatar,
  signedUpPerson,
} from './auth';

// A superset of 14-guards-sign-out.spec.ts (QA port): every private route, and return paths.
const PROTECTED = [
  '/home',
  '/request',
  '/requests',
  '/resources/food',
  '/check-in',
  '/consents',
  '/trusted-contacts',
  '/notifications',
  '/serve',
  '/chat',
  '/welcome',
  '/verify',
  '/admin',
];
const VETERAN_ONLY = [
  '/request',
  '/requests',
  '/resources/food',
  '/check-in',
  '/consents',
  '/trusted-contacts',
];

test('signed out, every private page goes to sign in', async ({ browser }) => {
  const page = await newPerson(browser);
  for (const path of PROTECTED) {
    await page.goto(path);
    await expect(page, `${path} while signed out`).toHaveURL(/\/sign-in$/);
  }
  await page.goto('/crisis');
  await expect(page).toHaveURL(/\/crisis$/);
});

test('a new person sent to sign in from a Veteran page is brought back there through every step', async ({
  browser,
  request,
}) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('return-chain');
  await page.goto('/resources/food');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await enterCode(page, await readSignInCode(request, email));
  await expect(page).toHaveURL(/\/welcome$/);
  await saveProfile(page, 'Cy H.', 'Santa Clara');
  await expect(page).toHaveURL(/\/verify$/);
  await page.getByRole('button', { name: 'Start verification' }).click();
  await expect(page.getByRole('heading', { name: /You're confirmed/ })).toBeVisible();
  await page
    .getByRole('link', { name: 'Continue' })
    .or(page.getByRole('button', { name: 'Continue' }))
    .click();
  await expect(page).toHaveURL(/\/resources\/food$/);
});

test('a returning person sent to sign in from Serve comes back to Serve, even if they chose "I need support"', async ({
  browser,
  request,
}) => {
  const first = await signedUpPerson(browser, request, { label: 'return-serve', name: 'Jo L.' });
  await first.page.context().close();
  const page = await newPerson(browser);
  await page.goto('/serve');
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.getByRole('radio', { name: /I need support/ }).check();
  await page.getByLabel('Email address').fill(first.email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await enterCode(page, await readSignInCode(request, first.email));
  await expect(page).toHaveURL(/\/serve$/);
});

test('signed in with no profile: app pages go to /welcome, and saving returns to the page asked for', async ({
  browser,
  request,
}) => {
  const { page } = await onWelcome(browser, request, 'no-profile');
  for (const path of ['/home', '/serve', '/chat', '/verify', '/request', '/check-in']) {
    await page.goto(path);
    await expect(page, `${path} with no profile`).toHaveURL(/\/welcome$/);
  }
  // Notifications and the crisis screen need no profile.
  await page.goto('/notifications');
  await expect(page).toHaveURL(/\/notifications$/);
  await page.goto('/crisis');
  await expect(page).toHaveURL(/\/crisis$/);

  await page.goto('/serve');
  await expect(page).toHaveURL(/\/welcome$/);
  await saveProfile(page, 'Vi T.', 'Alameda');
  await expect(page).toHaveURL(/\/serve$/);
});

test('not confirmed: Veteran-only pages go to /verify; Home, Serve, chat, notifications and crisis stay open', async ({
  browser,
  request,
}) => {
  const { page } = await signedUpPerson(browser, request, { label: 'unverified', name: 'Pat E.' });
  for (const path of VETERAN_ONLY) {
    await page.goto(path);
    await expect(page, `${path} before the ID check`).toHaveURL(/\/verify$/);
  }
  for (const path of ['/home', '/serve', '/chat', '/notifications', '/crisis']) {
    await page.goto(path);
    await expect(page, `${path} before the ID check`).toHaveURL(new RegExp(`${path}$`));
  }
});

test('signing out from the Need support header, then Back, shows no private page', async ({
  browser,
  request,
}) => {
  const { page } = await signedUpPerson(browser, request, { label: 'out-home', name: 'Quinn A.' });
  await expect(page.getByText(/Good (morning|afternoon|evening), Quinn\./)).toBeVisible();
  await page.goto('/notifications');
  await page.waitForLoadState('networkidle');
  await signOutFromAvatar(page, 'Quinn');
  await expect(page).toHaveURL(LANDING);
  // A fresh page load does not know the sign-out was on purpose, so Back may land on /sign-in.
  await page.goBack();
  await expect(page).toHaveURL(/\/sign-in$|:\d+\/$/);
  await expect(page.getByText('Quinn')).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(/\/(home|notifications)$/);
  await expect(page.getByText('Quinn')).toHaveCount(0);
});

test('signing out from the Serve header, then Back, shows no private page', async ({
  browser,
  request,
}) => {
  const { page } = await signedUpPerson(browser, request, {
    label: 'out-serve',
    name: 'Rory B.',
    role: 'serve',
  });
  await page.waitForLoadState('networkidle');
  await signOutFromAvatar(page, 'Rory');
  await expect(page).toHaveURL(LANDING);
  await page.goBack();
  await expect(page).not.toHaveURL(/\/serve$/);
  await expect(page.getByText('Rory')).toHaveCount(0);
});

test('signing out from the chat screen header ends on the landing page', async ({
  browser,
  request,
}) => {
  const { page } = await signedUpPerson(browser, request, { label: 'out-chat', name: 'Sky C.' });
  await page.goto('/chat');
  await page.waitForLoadState('networkidle');
  await signOutFromAvatar(page, 'Sky');
  await expect(page).toHaveURL(LANDING);
  await page.goBack();
  await expect(page).not.toHaveURL(/\/chat$/);
});

for (const where of ['/welcome', '/verify']) {
  test(`signing out from the onboarding header on ${where} ends on the landing page`, async ({
    browser,
    request,
  }) => {
    const { page } = await onWelcome(browser, request, 'out-onboarding');
    if (where === '/verify') {
      await saveProfile(page, 'Tam F.', 'Merced');
      await expect(page).toHaveURL(/\/home$/);
      await page.goto('/request');
      await expect(page).toHaveURL(/\/verify$/);
    }
    await page.waitForLoadState('networkidle');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(LANDING);
    await page.goBack();
    await expect(page).not.toHaveURL(new RegExp(`${where}$`));
  });
}

// AUTH-1 regression: a read still in flight at sign-out comes back 401; that must not turn
// the sign-out into "session expired" (/sign-in).
test('signing out while a page is still loading ends on the landing page', async ({
  browser,
  request,
}) => {
  const { page } = await signedUpPerson(browser, request, {
    label: 'out-race',
    name: 'Val H.',
    role: 'serve',
  });
  let loggedOut: () => void = () => undefined;
  const logout = new Promise<void>((resolve) => {
    loggedOut = resolve;
  });
  page.on('response', (response) => {
    if (response.url().endsWith('/auth/sessions/commands/logout')) loggedOut();
  });
  // Serve's open list is held until the sign-out has reached the server (real 401 after).
  await page.route(/\/api\/v0\/service-requests\?ownership=open/, async (route) => {
    await logout;
    await route.continue();
  });
  await page.goto('/serve');
  const held = page.waitForResponse(/\/api\/v0\/service-requests\?ownership=open/);
  await signOutFromAvatar(page, 'Val');
  expect((await held).status(), 'the held read reaches the server after the sign-out').toBe(401);
  await page.waitForLoadState('networkidle');
  expect(page.url()).toMatch(LANDING);
  await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
});

test('an unknown address shows a not-found page with a working way to the start', async ({
  browser,
  request,
}) => {
  const visitor = await newPerson(browser);
  for (const path of ['/no-such-page', '/serve/nope', '/requests/x/y']) {
    await visitor.goto(path);
    await expect(
      visitor.getByRole('heading', { name: 'We could not find that page.' }),
    ).toBeVisible();
    await expect(visitor).toHaveTitle('Page not found · SUAS');
  }
  await expectNoDeadControls(visitor);
  await shoot(visitor, 'auth-not-found');
  await visitor.getByRole('link', { name: 'Go to the start' }).click();
  await expect(visitor).toHaveURL(LANDING);

  const { page } = await signedUpPerson(browser, request, { label: 'not-found', name: 'Wes J.' });
  await page.goto('/nothing-here');
  await expect(page.getByRole('heading', { name: 'We could not find that page.' })).toBeVisible();
  await page.getByRole('link', { name: 'Go to the start' }).click();
  await expect(page).toHaveURL(LANDING);
});
