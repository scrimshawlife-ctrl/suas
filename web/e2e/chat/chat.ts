/**
 * Steps for the chat flows: the message column, sending as a person does, the conversation list,
 * and a requester whose request a helper has taken.
 */

import {
  expect,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { newHelper, newRequester, sendRequest, take } from '../serve/serve';

export function history(page: Page): Locator {
  return page.getByRole('region', { name: 'Message history' });
}

/** Types into the composer for `name` and presses Send; waits until the message is stored. */
export async function say(page: Page, name: string, text: string): Promise<void> {
  await page.getByLabel(`Message ${name}`).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(history(page).getByText('Sending', { exact: true })).toHaveCount(0);
  await expect(history(page)).toContainText(text.slice(0, 60));
}

export function threadLink(page: Page, name: RegExp): Locator {
  return page.getByRole('navigation', { name: 'Conversations' }).getByRole('link', { name });
}

/** Marcus T.'s request, taken by Dee R.; the helper ends on the case page. */
export async function pair(
  browser: Browser,
  request: APIRequestContext,
  options: { helperViewport?: { width: number; height: number } } = {},
): Promise<{ requester: Page; helper: Page; helperEmail: string; id: string; summary: string }> {
  const requester = await newRequester(browser, request, { name: 'Marcus T.' });
  const sent = await sendRequest(requester, request);
  const helper = await newHelper(browser, request, {
    name: 'Dee R.',
    ...(options.helperViewport ? { viewport: options.helperViewport } : {}),
  });
  await take(helper.page, sent.summary, sent.id);
  return { requester, helper: helper.page, helperEmail: helper.email, ...sent };
}
