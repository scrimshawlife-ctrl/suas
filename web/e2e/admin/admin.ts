/**
 * Helpers for the admin scenarios, ported from the QA sweep. The seeded admin signs in
 * through the UI; the only direct DB writes move time (the sign-in rate-limit window, the
 * MFA elevation age), which a person cannot do.
 */

import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { newPerson, scriptModel, signInWithCode } from '../helpers';
import { resetSignInLimits } from '../auth/auth';

export const ADMIN_EMAIL = 'admin@example.invalid';

/**
 * The seeded admin, signed in with a code, on /home (no MFA yet). The admin may ask for
 * three codes per 15 minutes and every test signs in afresh, so the window is moved on first.
 */
export async function signInAdmin(browser: Browser, request: APIRequestContext): Promise<Page> {
  await resetSignInLimits(ADMIN_EMAIL);
  const page = await newPerson(browser);
  await signInWithCode(page, request, ADMIN_EMAIL);
  await expect(page).toHaveURL(/\/home$/);
  return page;
}

/** Reads the dev-build hint on /admin/mfa and returns the response the test factor accepts. */
export async function testFactorResponse(page: Page): Promise<string> {
  const hint = await page.getByText(/This check id is/).textContent();
  const checkId = /This check id is ([^\s]+?)\.$/.exec((hint ?? '').trim())?.[1];
  expect(checkId, 'the dev hint names the check id').toBeTruthy();
  return `ok-${checkId ?? ''}`;
}

/** On /admin/mfa: start a check and answer it. */
export async function passMfa(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/admin\/mfa$/);
  await page.getByRole('button', { name: 'Start check' }).click();
  await page.getByLabel('Your response').fill(await testFactorResponse(page));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page).not.toHaveURL(/\/admin\/mfa$/);
}

/** The seeded admin, signed in and stepped up, on /admin. */
export async function elevatedAdmin(browser: Browser, request: APIRequestContext): Promise<Page> {
  const page = await signInAdmin(browser, request);
  await page.goto('/admin');
  await passMfa(page);
  await expect(page).toHaveURL(/\/admin$/);
  return page;
}

/**
 * A second tab of the same browser on `path`. sessionStorage is per tab, so the session and
 * MFA flag are copied over, as a duplicated tab would carry them.
 */
export async function duplicateTab(page: Page, path: string): Promise<Page> {
  const stored = await page.evaluate(() => ({
    session: sessionStorage.getItem('suas.session') ?? '',
    mfa: sessionStorage.getItem('suas.mfa'),
  }));
  const tab = await page.context().newPage();
  await tab.goto('/');
  await tab.evaluate(({ session, mfa }) => {
    sessionStorage.setItem('suas.session', session);
    if (mfa !== null) sessionStorage.setItem('suas.mfa', mfa);
  }, stored);
  await tab.goto(path);
  return tab;
}

export type ExtractedResource = {
  service_name: string;
  category: 'FOOD' | 'TRANSPORTATION' | 'SHELTER' | 'PEER_SUPPORT';
  counties?: string[];
  eligibility?: string;
  hours?: string;
  contacts?: { kind: 'PHONE' | 'EMAIL' | 'URL' | 'FREEFORM'; value: string }[];
  area?: string;
  referral_method?: string;
  cost?: string;
};

/** A unique synthetic service name, so runs and tests never collide. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${randomUUID().slice(0, 6)}`;
}

/** Queues one catalog-builder reply that records the given resources. */
export async function scriptExtraction(
  request: APIRequestContext,
  resources: ExtractedResource[],
): Promise<void> {
  await scriptModel(request, [
    {
      ok: true,
      text: '',
      toolCalls: [
        {
          id: `r-${randomUUID().slice(0, 6)}`,
          name: 'record_resources',
          // The builder's schema needs a counties list; [] means "no county limit stated".
          input: { resources: resources.map((r) => ({ counties: [], ...r })) },
        },
      ],
    },
  ]);
}

/** On /admin/drafts: paste a source for the scripted resources and create drafts. */
export async function extractDrafts(
  page: Page,
  request: APIRequestContext,
  resources: ExtractedResource[],
  sourceLink = 'https://source.example.invalid/listing',
): Promise<void> {
  await scriptExtraction(request, resources);
  await page
    .getByLabel('Source text')
    .fill(resources.map((r) => `${r.service_name}. ${r.hours ?? ''}`).join('\n'));
  await page.getByLabel('Source link').fill(sourceLink);
  await page.getByRole('button', { name: 'Create drafts' }).click();
  const word = resources.length === 1 ? 'Created 1 draft.' : `Created ${resources.length} drafts.`;
  await expect(page.getByText(word)).toBeVisible();
}

/** Extracts one fresh draft and opens it at /admin/drafts/:id. Returns the id. */
export async function openNewDraft(
  page: Page,
  request: APIRequestContext,
  resource: ExtractedResource,
): Promise<string> {
  await page.goto('/admin/drafts');
  await expect(page.getByRole('heading', { level: 1, name: 'Resource drafts' })).toBeVisible();
  await extractDrafts(page, request, [resource]);
  await page.getByRole('status').getByRole('link', { name: resource.service_name }).click();
  await expect(page).toHaveURL(/\/admin\/drafts\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: resource.service_name })).toBeVisible();
  return page.url().split('/').pop() ?? '';
}
