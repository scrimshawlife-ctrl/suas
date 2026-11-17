/**
 * Helpers for the auth scenarios (landing, sign-in, welcome, guards, session end), ported
 * from the QA sweep. People act through the UI; the database is touched only to do what a
 * person cannot: move the sign-in rate-limit window on, or suspend an account.
 */

import {
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
  type Response,
} from '@playwright/test';
import { newPerson, readSignInCode, uniqueEmail, withDb, type CountyLabel } from '../helpers';
import { deadControls } from '../watch';

export const LANDING = /:\d+\/$/;

/** /sign-in with a role chosen and a code asked for; ends on /sign-in/code. */
export async function askForCode(
  page: Page,
  email: string,
  role: 'need' | 'serve' = 'need',
): Promise<void> {
  await page.goto('/sign-in');
  await page
    .getByRole('radio', { name: role === 'need' ? /I need support/ : /I want to serve/ })
    .check();
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  await expect(page).toHaveURL(/\/sign-in\/code$/);
}

export async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify and continue' }).click();
}

/** Fills /welcome and saves. */
export async function saveProfile(page: Page, name: string, county: CountyLabel): Promise<void> {
  await page.getByLabel('Name other veterans will see').fill(name);
  await page.getByLabel('County').selectOption({ label: county });
  await page.getByRole('button', { name: 'Save and continue' }).click();
}

/** A new person signed in for the first time, on /welcome. */
export async function onWelcome(
  browser: Browser,
  request: APIRequestContext,
  label: string,
  role: 'need' | 'serve' = 'need',
): Promise<{ page: Page; email: string }> {
  const page = await newPerson(browser);
  const email = uniqueEmail(label);
  await askForCode(page, email, role);
  await enterCode(page, await readSignInCode(request, email));
  await expect(page).toHaveURL(/\/welcome$/);
  return { page, email };
}

/** Opens the avatar menu and signs out. */
export async function signOutFromAvatar(page: Page, firstName: string): Promise<void> {
  await page.getByRole('button', { name: `Account and sign out for ${firstName}` }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
}

/** Counts requests whose method and path match, from now on. */
export function countRequests(page: Page, method: string, path: RegExp): () => number {
  let count = 0;
  page.on('request', (request) => {
    if (request.method() === method && path.test(new URL(request.url()).pathname)) count += 1;
  });
  return () => count;
}

/** The next response to `method` on a path matching `path`, for checking real API errors. */
export function nextResponse(page: Page, method: string, path: RegExp): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === method && path.test(new URL(response.url()).pathname),
  );
}

/** The profile read, sent once per page load (it stays fresh for 30 s). */
export const ME_READ = /\/api\/v0\/veterans\/me$/;

/** Home's own reads on arrival: the person's requests and the header's chat threads. */
export const HOME_READS: readonly RegExp[] = [
  /\/api\/v0\/service-requests\?ownership=requested(&|$)/,
  /\/api\/v0\/chat\/threads(\?|$)/,
];

/**
 * Resolves once one GET to each of `urls` has answered 200. Start it before the action that
 * sends them. `networkidle` only covers a document's first load, not in-app moves or polls.
 */
export async function readsAnswered(page: Page, urls: readonly RegExp[]): Promise<void> {
  const responses = await Promise.all(
    urls.map((url) =>
      page.waitForResponse((r) => r.request().method() === 'GET' && url.test(r.url())),
    ),
  );
  for (const response of responses) expect(response.status(), response.url()).toBe(200);
}

/** The `error.code` of an /api/v0 error envelope. */
export async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

/** Pixels the page scrolls sideways; 0 or less means it fits. */
export function sidewaysScroll(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Fails the test if the page has a link or button with no real target or name. */
export async function expectNoDeadControls(page: Page): Promise<void> {
  expect(await deadControls(page), `dead controls on ${page.url()}`).toEqual([]);
}

/**
 * Drops the sign-in rate-limit counters, as if their 15-minute window had passed. With an
 * address, only that address's counters go.
 */
export async function resetSignInLimits(destination?: string): Promise<void> {
  await withDb((db) =>
    destination === undefined
      ? db.query('DELETE FROM auth_rate_limits')
      : db.query('DELETE FROM auth_rate_limits WHERE subject = $1', [destination]),
  );
}
