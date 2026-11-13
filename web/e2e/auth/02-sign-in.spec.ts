import { expect, test, type Response } from '@playwright/test';
import { newPerson, readSignInCode, shoot, uniqueEmail, withDb } from '../helpers';
import {
  askForCode,
  countRequests,
  enterCode,
  errorCode,
  expectNoDeadControls,
  nextResponse,
  resetSignInLimits,
  saveProfile,
  signOutFromAvatar,
  signedUpPerson,
} from './auth';

const CHALLENGES = /\/api\/v0\/auth\/challenges$/;
const VERIFY = /\/api\/v0\/auth\/challenges\/commands\/verify$/;
const WRONG_CODE = 'The sign-in code is invalid or has expired.';
const TOO_MANY = /^Too many tries\. Try again in \d+ (minutes?|seconds?)\.$/;

/** A real 429 from the sign-in budget: RATE_LIMITED with a positive Retry-After. */
async function expectRateLimited(response: Response): Promise<void> {
  expect(response.status()).toBe(429);
  expect(await errorCode(response)).toBe('RATE_LIMITED');
  expect(Number(response.headers()['retry-after'])).toBeGreaterThan(0);
}

test('the sign-in screen checks the email before asking for a code', async ({ browser }) => {
  const page = await newPerson(browser);
  const sent = countRequests(page, 'POST', CHALLENGES);
  await page.goto('/sign-in');
  await expect(page).toHaveTitle('Sign in · SUAS');
  await expect(page.getByRole('heading', { level: 1, name: 'Join the mission' })).toBeVisible();
  // With no role in the address, "I need support" is chosen.
  await expect(page.getByRole('radio', { name: /I need support/ })).toBeChecked();
  await expectNoDeadControls(page);

  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page.getByText('Enter your email address.')).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeFocused();
  for (const bad of ['veteran', 'veteran@', 'veteran@example', 'a b@example.invalid']) {
    await page.getByLabel('Email address').fill(bad);
    await page.getByRole('button', { name: 'Send sign-in code' }).click();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await expect(page.getByLabel('Email address')).toBeFocused();
  }
  // Typing clears the message.
  await page.getByLabel('Email address').fill('veteran@example.invalid');
  await expect(page.getByText('Enter a valid email address.')).toHaveCount(0);
  expect(sent(), 'no code is asked for while the email is invalid').toBe(0);
});

test('a returning person signs in as a helper and lands on Serve', async ({ browser, request }) => {
  const first = await signedUpPerson(browser, request, { label: 'returning', name: 'Ira S.' });
  await first.page.context().close();

  const page = await newPerson(browser);
  await askForCode(page, first.email, 'serve');
  await expect(page).toHaveTitle('Enter the code · SUAS');
  await expect(page.getByText(first.email)).toBeVisible();
  await expectNoDeadControls(page);
  await enterCode(page, await readSignInCode(request, first.email));
  await expect(page).toHaveURL(/\/serve$/);
  // Back goes past the used code page: sign-in redirects a signed-in person home.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/sign-in/);
});

test('a wrong code is a real 401 CHALLENGE_INVALID in plain words; a short code sends nothing', async ({
  browser,
  request,
}) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('wrong-code');
  await askForCode(page, email);

  // Short code: checked in the page, nothing sent.
  const verifies = countRequests(page, 'POST', VERIFY);
  await enterCode(page, '12');
  await expect(page.getByText('Enter all 6 digits.')).toBeVisible();
  await expect(page.getByLabel('6-digit code')).toBeFocused();
  expect(verifies()).toBe(0);

  // Letters and spaces are dropped as you type, and a pasted "123 456" keeps its six digits.
  await page.getByLabel('6-digit code').fill('');
  await page.getByLabel('6-digit code').pressSequentially('12 ab-34');
  await expect(page.getByLabel('6-digit code')).toHaveValue('1234');
  await page.getByLabel('6-digit code').evaluate((input) => {
    const data = new DataTransfer();
    data.setData('text/plain', '123 456');
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await expect(page.getByLabel('6-digit code')).toHaveValue('123456');

  const code = await readSignInCode(request, email);
  const refused = nextResponse(page, 'POST', VERIFY);
  await enterCode(page, code === '000000' ? '111111' : '000000');
  const response = await refused;
  expect(response.status()).toBe(401);
  expect(await errorCode(response)).toBe('CHALLENGE_INVALID');
  await expect(page.getByText(WRONG_CODE)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await shoot(page, 'auth-code-wrong');

  await enterCode(page, code);
  await expect(page).toHaveURL(/\/welcome$/);
});

test('an expired code is refused', async ({ browser, request }) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('expired');
  await askForCode(page, email);
  const code = await readSignInCode(request, email);
  // Moves time: the code was issued more than 15 minutes ago.
  await withDb((db) =>
    db.query(
      `UPDATE auth_challenges SET expires_at = now() - interval '1 minute' WHERE destination = $1`,
      [email],
    ),
  );
  await enterCode(page, code);
  await expect(page.getByText(WRONG_CODE)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
});

test('asking again for a code makes the earlier code stop working', async ({
  browser,
  request,
}) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('resend');
  await askForCode(page, email);
  const firstCode = await readSignInCode(request, email);

  // There is no "send a new code" button; "Use a different email" is the way back.
  await expect(page.getByRole('button', { name: /resend|new code|send again/i })).toHaveCount(0);
  await page.getByRole('link', { name: 'Use a different email' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByLabel('Email address')).toHaveValue('');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  const secondCode = await readSignInCode(request, email);
  test.skip(firstCode === secondCode, 'the two random codes happen to match');

  await enterCode(page, firstCode);
  await expect(page.getByText(WRONG_CODE)).toBeVisible();
  await enterCode(page, secondCode);
  await expect(page).toHaveURL(/\/welcome$/);
});

test('a code that was already used does not sign in again', async ({ browser, request }) => {
  const { page, email } = await signedUpPerson(browser, request, {
    label: 'used-code',
    name: 'Uma V.',
  });
  const usedCode = await readSignInCode(request, email);
  await signOutFromAvatar(page, 'Uma');
  await expect(page).toHaveURL(/:\d+\/$/);

  await askForCode(page, email);
  const fresh = await readSignInCode(request, email);
  test.skip(fresh === usedCode, 'the two random codes happen to match');
  await enterCode(page, usedCode);
  await expect(page.getByText(WRONG_CODE)).toBeVisible();
});

test('the fourth code request in 15 minutes is a real 429 with a wait time', async ({
  browser,
}) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('issue-limit');
  for (let i = 0; i < 3; i += 1) await askForCode(page, email);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  const limited = nextResponse(page, 'POST', CHALLENGES);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expectRateLimited(await limited);
  await expect(page.getByText(TOO_MANY)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('after the verify budget the right code is refused 429; once the window passes, sign-in works', async ({
  browser,
  request,
}) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('verify-limit');
  await askForCode(page, email);
  const code = await readSignInCode(request, email);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i += 1) {
    await enterCode(page, wrong);
    await expect(page.getByText(WRONG_CODE)).toBeVisible();
  }
  // Even the right code is refused now, with a wait time instead of a raw error.
  const limited = nextResponse(page, 'POST', VERIFY);
  await enterCode(page, code);
  await expectRateLimited(await limited);
  await expect(page.getByText(TOO_MANY)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in\/code$/);

  // Fifteen minutes pass (the window is reset in the database). Five wrong tries also spent
  // that code's attempts, so the person asks for a new one, and it signs them in.
  await resetSignInLimits(email);
  await page.getByRole('link', { name: 'Use a different email' }).click();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await enterCode(page, await readSignInCode(request, email));
  await expect(page).toHaveURL(/\/welcome$/);
});

test('Back, Forward and refresh on the code page keep the sign-in going', async ({
  browser,
  request,
}) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('code-nav');
  await askForCode(page, email);
  await page.goBack();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goForward();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await expect(page.getByText(email)).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await expect(page.getByText(email)).toBeVisible();
  await enterCode(page, await readSignInCode(request, email));
  await expect(page).toHaveURL(/\/welcome$/);
});

test('opening the code page with no sign-in started goes to sign in', async ({ browser }) => {
  const page = await newPerson(browser);
  await page.goto('/sign-in/code');
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Join the mission' })).toBeVisible();
});

test('double-clicking Send and Verify asks once and signs in once', async ({
  browser,
  request,
}) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('double');
  const sent = countRequests(page, 'POST', CHALLENGES);
  const verified = countRequests(page, 'POST', VERIFY);
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).dblclick();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await page.getByLabel('6-digit code').fill(await readSignInCode(request, email));
  await page.getByRole('button', { name: 'Verify and continue' }).dblclick();
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByText(WRONG_CODE)).toHaveCount(0);
  expect(sent(), 'one code request').toBe(1);
  expect(verified(), 'one verify request').toBe(1);
});

test('a signed-in person who opens sign-in again goes to their home', async ({
  browser,
  request,
}) => {
  const { page } = await signedUpPerson(browser, request, {
    label: 'again',
    name: 'Bo K.',
    role: 'serve',
  });
  for (const path of ['/sign-in', '/sign-in?role=need', '/sign-in/code']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/serve$/);
  }
});

test('when SUAS cannot be reached or fails, sign-in says so and works on the next try', async ({
  browser,
  request,
}) => {
  const page = await newPerson(browser);
  const email = uniqueEmail('offline');
  await page.goto('/sign-in');
  await page.getByLabel('Email address').fill(email);

  // Offline and 5xx cannot be reached on the real stack, so these two are routed.
  await page.route(CHALLENGES, (route) => route.abort('internetdisconnected'));
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(
    page.getByText('We could not reach SUAS. Check your connection and try again.'),
  ).toBeVisible();
  await page.unroute(CHALLENGES);

  await page.route(CHALLENGES, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }),
    }),
  );
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(
    page.getByText('Sign-in is not available right now. Try again in a few minutes.'),
  ).toBeVisible();
  await page.unroute(CHALLENGES);

  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
  await enterCode(page, await readSignInCode(request, email));
  await expect(page).toHaveURL(/\/welcome$/);
  await saveProfile(page, 'Oz N.', 'Merced');
  await expect(page).toHaveURL(/\/home$/);
});
