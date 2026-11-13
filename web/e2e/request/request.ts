/**
 * Helpers for the requester flows (`web/e2e/request`). Ported from the QA sweep's
 * `request/people.ts`; people come from the shared helpers so each has their own context.
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
export { tag } from '../helpers';
export { take } from '../serve/serve';
import { newPerson, newVerifiedVeteran, signUp, uniqueEmail, type CountyLabel } from '../helpers';

/** A signed-up, ID-checked Veteran on /home. */
export async function veteran(
  browser: Browser,
  request: APIRequestContext,
  options: { name: string; county?: CountyLabel },
): Promise<Page> {
  const { page } = await newVerifiedVeteran(browser, request, {
    name: options.name,
    county: options.county ?? 'Santa Clara',
    label: 'req',
  });
  return page;
}

/** A signed-up helper in Serve mode, on /serve. */
export async function helper(
  browser: Browser,
  request: APIRequestContext,
  options: { name: string; county?: CountyLabel },
): Promise<Page> {
  const page = await newPerson(browser);
  await signUp(page, request, {
    email: uniqueEmail('req-helper'),
    name: options.name,
    county: options.county ?? 'Santa Clara',
    role: 'serve',
  });
  return page;
}

/** The id at the end of a /requests/:id address. */
export function idFromUrl(page: Page): string {
  return page.url().split('/').pop()?.split('?')[0] ?? '';
}

/** Sends a peer-support request through the plain form and returns its id. */
export async function sendPeerRequest(page: Page, summary: string): Promise<string> {
  await page.goto('/request?category=PEER_SUPPORT');
  const form = page.getByRole('form', { name: 'Request form' });
  await form.getByLabel('Short summary').fill(summary);
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
  return idFromUrl(page);
}

/** Rows in the full /requests list, read like a person would: one link per request. */
export async function requestRows(page: Page): Promise<Locator> {
  await page.goto('/requests');
  await expect(page.getByRole('heading', { level: 1, name: 'Your requests' })).toBeVisible();
  return page.getByRole('main').getByRole('listitem').getByRole('link');
}

/**
 * Creates peer-support requests through the API with the page's own session, oldest first.
 * Only for volume (list paging); every flow under test still goes through the page.
 */
export async function seedRequests(
  page: Page,
  request: APIRequestContext,
  summaries: string[],
): Promise<void> {
  const token = await page.evaluate(() => sessionStorage.getItem('suas.session'));
  expect(token, 'the page holds a session').not.toBeNull();
  for (const summary of summaries) {
    const response = await request.post(`${API_URL}/api/v0/service-requests`, {
      headers: { Authorization: `Bearer ${token ?? ''}`, 'Idempotency-Key': randomUUID() },
      data: { category: 'PEER_SUPPORT', summary },
    });
    expect(response.status(), await response.text()).toBe(201);
  }
}

/** Records every POST the page sends whose URL matches, with its body and response status. */
export function recordPosts(
  page: Page,
  pattern: RegExp,
): { status: number; url: string; body: unknown }[] {
  const seen: { status: number; url: string; body: unknown }[] = [];
  page.on('response', (response) => {
    const sent = response.request();
    if (sent.method() === 'POST' && pattern.test(sent.url())) {
      seen.push({ status: response.status(), url: sent.url(), body: sent.postDataJSON() });
    }
  });
  return seen;
}

/** Starts recording the text of every role=alert that appears, even for a moment. */
export async function recordAlerts(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __alerts: string[] }).__alerts = seen;
    const note = (node: Node) => {
      if (node instanceof HTMLElement) {
        node.querySelectorAll('[role="alert"]').forEach((el) => seen.push(el.textContent ?? ''));
        if (node.getAttribute('role') === 'alert') seen.push(node.textContent ?? '');
      }
    };
    new MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach(note));
    }).observe(document.body, { childList: true, subtree: true });
  });
  return () => page.evaluate(() => (window as unknown as { __alerts: string[] }).__alerts);
}

/**
 * Two clicks in one browser task, with nothing competing for the CPU between them.
 * Playwright's dblclick spaces the clicks out, which can hide a missing double-submit guard.
 */
export async function fastDoubleClick(button: Locator): Promise<void> {
  await button.evaluate((el: HTMLElement) => {
    el.click();
    el.click();
  });
}
