/**
 * M5: both sides chat, and each sees the unread badge while on another screen. The badge's
 * thread list refetches every 60 s; `page.clock` is paused just after one refetch and run to either side of the next.
 */

import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { history, pair, say, threadLink } from '../chat/chat';
import { POLL_MARGIN_MS, pauseAfterPoll, runClock } from '../helpers';
import { tag } from '../serve/serve';

test.describe.configure({ timeout: 180_000 });

/** The badge's thread list refetch (UNREAD_REFETCH_MS in src/features/chat/unread.ts). */
const UNREAD_REFETCH_MS = 60_000;
const isThreadsRead = (url: string) => url.includes('/api/v0/chat/threads');

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
  await pauseAfterPoll(requester, isThreadsRead, UNREAD_REFETCH_MS);
  await helper.goto(`/chat/${id}`);
  const hello = `Hi Marcus, I can drive you ${tag()}`;
  await say(helper, 'Marcus T.', hello);

  // Nothing before the next unread read; it shows once that read lands.
  await runClock(requester, UNREAD_REFETCH_MS - POLL_MARGIN_MS);
  await expect(primary(requester).getByRole('img', { name: '1 unread' })).toHaveCount(0);
  await runClock(requester, POLL_MARGIN_MS);
  await requester.clock.resume();
  await expect(primary(requester).getByRole('img', { name: '1 unread' })).toBeVisible();
  await primary(requester).getByRole('link', { name: /Chat/ }).click();
  await expect(threadLink(requester, /Dee R\./)).toContainText(hello);
  await threadLink(requester, /Dee R\./).click();
  await expect(history(requester)).toContainText(hello);
  await expect(primary(requester).getByRole('img', { name: /unread/ })).toHaveCount(0);

  // The helper waits on the Serve board; the requester replies.
  await helper.goto('/serve');
  await expect(primary(helper).getByRole('img', { name: /unread/ })).toHaveCount(0);
  await pauseAfterPoll(helper, isThreadsRead, UNREAD_REFETCH_MS);
  const reply = `Thank you, see you at the library ${tag()}`;
  await say(requester, 'Dee R.', reply);

  await runClock(helper, UNREAD_REFETCH_MS - POLL_MARGIN_MS);
  await expect(primary(helper).getByRole('img', { name: '1 unread' })).toHaveCount(0);
  await runClock(helper, POLL_MARGIN_MS);
  await helper.clock.resume();
  await expect(primary(helper).getByRole('img', { name: '1 unread' })).toBeVisible();
  await primary(helper).getByRole('link', { name: /Chat/ }).click();
  await threadLink(helper, /Marcus T\./).click();
  await expect(history(helper)).toContainText(reply);
  await expect(primary(helper).getByRole('img', { name: /unread/ })).toHaveCount(0);
  // The requester's own reply is not unread for them.
  await expect(primary(requester).getByRole('img', { name: /unread/ })).toHaveCount(0);
});
