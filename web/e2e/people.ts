/**
 * The suite's test users: the one way to make a signed-up Veteran or helper. Each gets their own
 * browser context, so several people can be signed in at once. Both live in Santa Clara unless
 * the test names a county.
 */

import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { newPerson, passIdCheck, signUp, uniqueEmail, type CountyLabel } from './helpers';

export type Person = { page: Page; email: string };

type PersonOptions = {
  name: string;
  county?: CountyLabel;
  /** Goes into the synthetic email address only, to tell people apart in logs. */
  label?: string;
};

const DEFAULT_COUNTY: CountyLabel = 'Santa Clara';

/** A signed-up Veteran on /home, ID-checked unless `verified` is false. */
export async function newVeteran(
  browser: Browser,
  request: APIRequestContext,
  options: PersonOptions & { verified?: boolean },
): Promise<Person> {
  const page = await newPerson(browser);
  const email = uniqueEmail(options.label ?? 'vet');
  await signUp(page, request, {
    email,
    name: options.name,
    county: options.county ?? DEFAULT_COUNTY,
  });
  if (options.verified === false) return { page, email };
  await passIdCheck(page);
  // Continue with no return path goes to /request; Home is one link back from there.
  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/\/request$/);
  await page.getByRole('link', { name: /back to home/i }).click();
  await expect(page).toHaveURL(/\/home$/);
  return { page, email };
}

/** A signed-up helper in Serve mode (no ID check) on /serve. */
export async function newHelper(
  browser: Browser,
  request: APIRequestContext,
  options: PersonOptions & { viewport?: { width: number; height: number } },
): Promise<Person> {
  const page = await newPerson(browser, options.viewport);
  const email = uniqueEmail(options.label ?? 'helper');
  await signUp(page, request, {
    email,
    name: options.name,
    county: options.county ?? DEFAULT_COUNTY,
    role: 'serve',
  });
  return { page, email };
}
