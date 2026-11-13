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

/** A new person signed up with a profile, on their role's home page. */
export async function signedUpPerson(
  browser: Browser,
  request: APIRequestContext,
  options: { label: string; name: string; county?: CountyLabel; role?: 'need' | 'serve' },
): Promise<{ page: Page; email: string }> {
  const role = options.role ?? 'need';
  const person = await onWelcome(browser, request, options.label, role);
  await saveProfile(person.page, options.name, options.county ?? 'Alameda');
  await expect(person.page).toHaveURL(role === 'need' ? /\/home$/ : /\/serve$/);
  return person;
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

/**
 * Visible links with no real target ("#", "javascript:", none) and buttons with no
 * accessible name: the QA sweep's dead-control check.
 */
export async function expectNoDeadControls(page: Page): Promise<void> {
  const found = await page.evaluate(() => {
    const dead: string[] = [];
    const visible = (el: Element) => {
      const box = (el as HTMLElement).getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    document.querySelectorAll('a').forEach((a) => {
      const href = a.getAttribute('href');
      if (
        visible(a) &&
        (href === null || href === '' || href === '#' || href.startsWith('javascript:'))
      )
        dead.push(`link "${(a.textContent ?? '').trim()}" href=${String(href)}`);
    });
    document.querySelectorAll('button, [role="button"]').forEach((b) => {
      const name = (b.getAttribute('aria-label') ?? b.textContent ?? '').trim();
      if (visible(b) && name === '') dead.push(`button with no name: ${b.outerHTML.slice(0, 120)}`);
    });
    return dead;
  });
  expect(found, `dead controls on ${page.url()}`).toEqual([]);
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
