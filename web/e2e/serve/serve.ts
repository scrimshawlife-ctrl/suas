/**
 * People and steps for the helper-side flows (serve, chat, multi-user). Ported from the QA
 * sweep's `serve/people.ts` onto the target's helpers; seeding through the API is limited to
 * volume a person could not type (paging fixtures).
 */

import { randomUUID } from 'node:crypto';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { API_URL } from '../config';
import { bearer, tag } from '../helpers';

export { bearer, tag };
import { newVerifiedVeteran, requestHelp, signUp, uniqueEmail, type CountyLabel } from '../helpers';

export const PHONE = { width: 390, height: 844 };

type Viewport = { width: number; height: number };

/** A signed-up, ID-checked Veteran, on /home. */
export async function newRequester(
  browser: Browser,
  request: APIRequestContext,
  options: { name: string; county?: CountyLabel },
): Promise<Page> {
  const { page } = await newVerifiedVeteran(browser, request, {
    name: options.name,
    county: options.county ?? 'Santa Clara',
    label: 'srv-req',
  });
  return page;
}

/** A signed-up helper (no ID check), on /serve, in their own browser context. */
export async function newHelper(
  browser: Browser,
  request: APIRequestContext,
  options: { name: string; county?: CountyLabel; viewport?: Viewport },
): Promise<{ page: Page; email: string }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  const email = uniqueEmail('srv-helper');
  await signUp(page, request, {
    email,
    name: options.name,
    county: options.county ?? 'Santa Clara',
    role: 'serve',
  });
  return { page, email };
}

/** The Veteran sends a transportation request through the assistant; returns its id and summary. */
export async function sendRequest(
  requester: Page,
  request: APIRequestContext,
  summary = `Ride to the clinic ${tag()}`,
): Promise<{ id: string; summary: string }> {
  const id = await requestHelp(
    requester,
    request,
    { category: 'TRANSPORTATION', summary, timing: 'Tomorrow at 9 am' },
    'Front entrance of the library',
  );
  return { id, summary };
}

export function openList(page: Page): Locator {
  return page.getByRole('region', { name: 'Open requests' });
}

export function takeButton(page: Page, summary: string): Locator {
  return page.getByRole('button', { name: new RegExp(`Take this request: .*${summary}`) });
}

/** The helper takes the request from the open list and lands on its case page. */
export async function take(helper: Page, summary: string, requestId: string): Promise<void> {
  await helper.goto('/serve');
  await takeButton(helper, summary).click();
  await expect(helper).toHaveURL(new RegExp(`/serve/requests/${requestId}$`));
}

export function progress(page: Page): Locator {
  return page.getByRole('region', { name: 'Progress' });
}

/** The value under one "Your summary" label on /serve. */
export function summaryValue(page: Page, label: string): Locator {
  return page
    .getByRole('region', { name: 'Your summary' })
    .locator('div', { has: page.getByText(label, { exact: true }) })
    .locator('dd');
}

/** Releases the open case page's request with a reason; ends on /serve. */
export async function release(page: Page, reason = 'My car broke down.'): Promise<void> {
  await page.getByRole('button', { name: 'Release this request' }).click();
  const dialog = page.getByRole('dialog', { name: 'Release this request?' });
  await dialog.getByLabel(/Why are you releasing it/).fill(reason);
  await dialog.getByRole('button', { name: 'Confirm release' }).click();
  await expect(page).toHaveURL(/\/serve$/);
}

/** The requester cancels from their open request page. */
export async function cancelOwnRequest(requester: Page, requestId: string): Promise<void> {
  await requester.goto(`/requests/${requestId}`);
  await requester.getByRole('button', { name: 'Cancel request' }).click();
  await requester
    .getByRole('dialog', { name: 'Cancel this request?' })
    .getByRole('button', { name: 'Cancel request' })
    .click();
  await expect(requester.getByText('Request cancelled.')).toBeVisible();
}

/**
 * Seeds `count` peer-support requests from `requester` and has `helper` accept each, through
 * the API (POST /service-requests, POST /service-requests/{id}/accept). Returns the summaries,
 * oldest first.
 */
export async function seedAcceptedRequests(
  request: APIRequestContext,
  requester: Page,
  helper: Page,
  count: number,
): Promise<string[]> {
  const asRequester = await bearer(requester);
  const asHelper = await bearer(helper);
  const run = tag();
  const summaries: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const summary = `Seeded ${String(n)} of ${run}`;
    const created = await request.post(`${API_URL}/api/v0/service-requests`, {
      headers: { ...asRequester, 'Idempotency-Key': randomUUID() },
      data: { category: 'PEER_SUPPORT', summary },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { service_request_id: id } = (await created.json()) as { service_request_id: string };
    const accepted = await request.post(`${API_URL}/api/v0/service-requests/${id}/accept`, {
      headers: { ...asHelper, 'Idempotency-Key': randomUUID() },
    });
    expect(accepted.ok(), await accepted.text()).toBe(true);
    summaries.push(summary);
  }
  return summaries;
}
