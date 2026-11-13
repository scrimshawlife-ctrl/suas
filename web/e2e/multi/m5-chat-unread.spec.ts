/**
 * M5: both sides chat, and each sees the unread badge while on another screen. The badge's
 * thread list refetches every 60 s; `page.clock` moves past that instead of a reload or a wait.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { history, pair, say, threadLink } from '../chat/chat';
import { tag } from '../serve/serve';

test.describe.configure({ timeout: 180_000 });

function primary(page: Page) {
  return page.getByRole('navigation', { name: 'Primary' }).first();
}

test('each side sees one unread on another screen, and reading the chat clears it', async ({
  browser,
  request,
}) => {
  const { requester, helper, id } = await pair(browser, request);
  await requester.clock.install();
  await helper.clock.install();

  // The requester waits on Home; the helper writes.
  await requester.goto('/home');
  await expect(primary(requester).getByRole('link', { name: 'Chat' })).toBeVisible();
  await helper.goto(`/chat/${id}`);
  const hello = `Hi Marcus, I can drive you ${tag()}`;
  await say(helper, 'Marcus T.', hello);

  await requester.clock.fastForward('01:05');
  await expect(primary(requester).getByRole('img', { name: '1 unread' })).toBeVisible();
  await primary(requester).getByRole('link', { name: /Chat/ }).click();
  await expect(threadLink(requester, /Dee R\./)).toContainText(hello);
  await threadLink(requester, /Dee R\./).click();
  await expect(history(requester)).toContainText(hello);
  await expect(primary(requester).getByRole('img', { name: /unread/ })).toHaveCount(0);

  // The helper waits on the Serve board; the requester replies.
  await helper.goto('/serve');
  await expect(primary(helper).getByRole('img', { name: /unread/ })).toHaveCount(0);
  const reply = `Thank you, see you at the library ${tag()}`;
  await say(requester, 'Dee R.', reply);

  await helper.clock.fastForward('01:05');
  await expect(primary(helper).getByRole('img', { name: '1 unread' })).toBeVisible();
  await primary(helper).getByRole('link', { name: /Chat/ }).click();
  await threadLink(helper, /Marcus T\./).click();
  await expect(history(helper)).toContainText(reply);
  await expect(primary(helper).getByRole('img', { name: /unread/ })).toHaveCount(0);
  // The requester's own reply is not unread for them.
  await expect(primary(requester).getByRole('img', { name: /unread/ })).toHaveCount(0);
});
