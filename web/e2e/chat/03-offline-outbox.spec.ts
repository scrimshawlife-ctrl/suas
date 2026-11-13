/**
 * The chat outbox while the browser is offline (`context.setOffline`): a send fails as "Not
 * sent.", later sends wait their turn, and "Try again" once back online stores each message
 * exactly once, in the order typed.
 */

import { expect, test } from '../fixtures';
import { tag } from '../serve/serve';
import { history, pair } from './chat';

test.describe.configure({ timeout: 180_000 });

test('messages typed offline show "Not sent." and go through once each after Try again online', async ({
  browser,
  request,
  allow,
}) => {
  // The errors this test provokes on purpose.
  allow.push(/ERR_INTERNET_DISCONNECTED/);
  const { requester, helper: page, id } = await pair(browser, request);
  await page.goto(`/chat/${id}`);
  await expect(page.getByLabel('Message Marcus T.')).toBeVisible();

  const first = `Running late ${tag()}`;
  const second = `Ten minutes away ${tag()}`;
  await page.context().setOffline(true);
  for (const text of [first, second]) {
    await page.getByLabel('Message Marcus T.').fill(text);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  }
  const failed = history(page).getByRole('listitem').filter({ hasText: 'Not sent.' });
  await expect(failed).toHaveCount(2);
  await expect(failed.first()).toContainText(first);

  await page.context().setOffline(false);
  for (const text of [first, second]) {
    await failed.filter({ hasText: text }).getByRole('button', { name: 'Try again' }).click();
    await expect(failed.filter({ hasText: text })).toHaveCount(0);
  }
  await expect(history(page).getByText('Sending', { exact: true })).toHaveCount(0);

  // The other side has each message once, in the order typed.
  await requester.goto(`/chat/${id}`);
  const items = history(requester).getByRole('listitem');
  await expect(items.filter({ hasText: first })).toHaveCount(1);
  await expect(items.filter({ hasText: second })).toHaveCount(1);
  const texts = await items.allInnerTexts();
  const at = (text: string) => texts.findIndex((t) => t.includes(text));
  expect(at(first)).toBeLessThan(at(second));
  // A reload on the sender's side keeps both, once each.
  await page.reload();
  await expect(history(page).getByText(first)).toHaveCount(1);
  await expect(history(page).getByText(second)).toHaveCount(1);
});
